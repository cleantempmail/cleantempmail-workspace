import { Hono } from "hono";
import { cfClient, loadSession, OPTIONAL_SCOPES, oauthConfigured, requireAdmin, requireSession, ReauthError, SCOPES, sessionTokenScope, workerAccountId } from "./auth";
import type { AppEnv } from "./env";
import { serveProxiedImage } from "./privacy";
import { account } from "./routes/account";
import { RESEND_FREE_DOMAINS, resendKey, SendError, type Provider } from "./providers";
import { checkHealth, fixHealth, provisionDomain, refreshSendStatus, releaseResend, removeDomain, resendUsage, setFallback, setupSending } from "./provision";
import { compose, HttpError, LIMITS } from "./routes/compose";
import { messages } from "./routes/messages";
import { org } from "./routes/org";
import { canUseDomain } from "./scope";
import { encrypt, getSetting, getSettings, isEmail, setSetting } from "./util";

export const api = new Hono<AppEnv>();

api.onError((err, c) => {
  if (err instanceof ReauthError) return c.json({ error: err.message, code: "reauth" }, 401);
  if (err instanceof SendError) return c.json({ error: err.message, code: err.code }, 400);
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: err.message || "服务器错误" }, 500);
});

// 公开：前端据此决定显示登录页、配置引导还是收件箱
api.get("/me", async (c) => {
  const session = await loadSession(c);
  let memberLogin = false;
  let unclaimed = false;
  let passwordLogin = false;
  let passkeyLogin = false;
  if (!session) {
    const row = await c.env.DB.prepare(
      `SELECT (SELECT value FROM settings WHERE key = 'pref_member_login') AS pref, EXISTS (SELECT 1 FROM members WHERE disabled = 0) AS has,
        EXISTS (SELECT 1 FROM settings WHERE key = 'owner_user_id') AS claimed,
        EXISTS (SELECT 1 FROM settings WHERE key = 'admin_password') AS pw,
        EXISTS (SELECT 1 FROM passkeys) AS pk`,
    ).first<{ pref: string | null; has: number; claimed: number; pw: number; pk: number }>();
    memberLogin = row?.pref !== "off" && Boolean(row?.has);
    // 还没有管理员（刚部署）：显示首次设置页（粘贴 API 令牌 + 设置密码）
    unclaimed = !row?.claimed;
    passwordLogin = Boolean(row?.pw);
    passkeyLogin = Boolean(row?.pk);
  }
  return c.json({
    memberLogin,
    unclaimed,
    passwordLogin,
    passkeyLogin,
    loggedIn: Boolean(session),
    email: session?.email ?? null,
    role: session?.role ?? null,
    scope: session?.scope ?? null,
    canManage: session?.role === "admin" && session.hasCfToken,
    oauthConfigured: oauthConfigured(c.env),
    devLogin: c.env.DEV_LOGIN === "1",
    redirectUri: new URL("/auth/callback", c.req.url).toString(),
    scopes: SCOPES.filter((s) => s !== "offline_access"),
    optionalScopes: OPTIONAL_SCOPES,
    limits: LIMITS,
    ai: Boolean(c.env.AI),
  });
});

// 图片隐私代理：链接由服务端签名（只有本服务改写过的邮件图片才能通过），所以不依赖登录 Cookie
api.get("/img", (c) => serveProxiedImage(c.env, c.req.query("u"), c.req.query("s"), new URL(c.req.url).hostname));

api.use("*", requireSession);

api.route("/", messages);
api.route("/", compose);
api.route("/", org);
api.route("/", account);

// ---------- 域名 ----------

api.get("/domains", async (c) => {
  const s = c.get("session");
  const { results } = await c.env.DB.prepare(
    `SELECT d.*, (SELECT COALESCE(SUM(total), 0) FROM mailbox_stats m WHERE m.domain = d.name) AS message_count FROM domains d ORDER BY d.name`,
  ).all<any>();
  // 成员只看到被授权的域名（以及被单独授权地址所在的域名）
  return c.json(s.scope.all ? results : results.filter((d) => canUseDomain(s.scope, d.name) || s.scope.addresses.some((a) => a.endsWith("@" + d.name))));
});

api.get("/zones", requireAdmin, async (c) => {
  const cf = await cfClient(c);
  const accountId = await workerAccountId(c.env, cf);
  const zones = await cf.zones(accountId);
  const { results } = await c.env.DB.prepare("SELECT name FROM domains").all<{ name: string }>();
  const configured = new Set(results.map((r) => r.name));
  return c.json(zones.map((z) => ({ id: z.id, name: z.name, configured: configured.has(z.name) })));
});

api.post("/domains", requireAdmin, async (c) => {
  const { zoneId, replaceMx } = await c.req.json<{ zoneId: string; replaceMx?: boolean }>();
  const cf = await cfClient(c);
  const accountId = await workerAccountId(c.env, cf);
  return c.json(await provisionDomain(c.env, cf, accountId, zoneId, { replaceMx }));
});

api.post("/domains/:name/sending", requireAdmin, async (c) => {
  const { provider } = await c.req.json<{ provider: Provider }>();
  const name = c.req.param("name")!;
  const row = await c.env.DB.prepare("SELECT zone_id FROM domains WHERE name = ?").bind(name).first<{ zone_id: string }>();
  if (!row) return c.json({ error: "域名不存在" }, 404);
  const steps = await setupSending(c.env, await cfClient(c), name, row.zone_id, provider);
  return c.json({ steps });
});

api.post("/domains/:name/fallback", requireAdmin, async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  // 关闭不需要 Cloudflare 授权；开启要写 DNS 记录
  const cf = enabled ? await cfClient(c) : null;
  return c.json(await setFallback(c.env, cf, c.req.param("name")!, Boolean(enabled)));
});

// 释放 Resend 名额：从 Resend 删除这个域名。Cloudflare 授权过期时仍然删除，只是跳过 DNS 清理
api.post("/domains/:name/resend/release", requireAdmin, async (c) => {
  const cf = await cfClient(c).catch(() => null);
  return c.json(await releaseResend(c.env, cf, c.req.param("name")!));
});

api.get("/resend/domains", requireAdmin, async (c) => {
  if (!(await resendKey(c.env))) return c.json({ configured: false, domains: [], freeLimit: RESEND_FREE_DOMAINS });
  return c.json({ configured: true, domains: await resendUsage(c.env), freeLimit: RESEND_FREE_DOMAINS });
});

api.post("/domains/:name/refresh", requireAdmin, async (c) => {
  await refreshSendStatus(c.env, c.req.param("name")!);
  return c.json({ ok: true });
});

api.get("/domains/:name/health", requireAdmin, async (c) => {
  return c.json(await checkHealth(c.env, await cfClient(c), c.req.param("name")!));
});

api.post("/domains/:name/fix", requireAdmin, async (c) => {
  return c.json(await fixHealth(c.env, await cfClient(c), c.req.param("name")!));
});

api.delete("/domains/:name", requireAdmin, async (c) => {
  const releaseResend = c.req.query("resend") === "1";
  return c.json({ ok: true, ...(await removeDomain(c.env, await cfClient(c), c.req.param("name")!, { releaseResend })) });
});

// ---------- 设置 ----------

async function trustedSenders(env: AppEnv["Bindings"]): Promise<string[]> {
  return JSON.parse((await getSetting(env, "pref_trusted_senders")) ?? "[]");
}

api.get("/settings", async (c) => {
  const admin = c.get("session").role === "admin";
  const [st, tokenScope] = await Promise.all([
    getSettings(c.env, ["resend_api_key", "pref_remote_images", "pref_trusted_senders", "pref_spam_score", "pref_ai_spam", "system_from", "pref_member_login"]),
    admin ? sessionTokenScope(c) : Promise.resolve(null),
  ]);
  return c.json({
    resendConfigured: admin ? Boolean(st.resend_api_key) : undefined,
    remoteImages: st.pref_remote_images ?? "always",
    trustedSenders: JSON.parse(st.pref_trusted_senders ?? "[]"),
    spamScore: admin ? st.pref_spam_score ?? "" : undefined,
    aiSpam: admin ? st.pref_ai_spam === "1" : undefined,
    systemFrom: admin ? st.system_from ?? "" : undefined,
    memberLogin: admin ? st.pref_member_login !== "off" : undefined,
    analyticsScope: tokenScope === null ? null : tokenScope.split(/\s+/).includes("analytics.read"),
    appSecret: admin ? Boolean(c.env.APP_SECRET) : undefined,
  });
});

api.put("/settings", async (c) => {
  const admin = c.get("session").role === "admin";
  const body = await c.req.json<{
    resendApiKey?: string | null;
    remoteImages?: "ask" | "always";
    trustSender?: string;
    untrustSender?: string;
    spamScore?: string | null;
    aiSpam?: boolean;
    systemFrom?: string | null;
    memberLogin?: boolean;
  }>();
  const adminOnly = ["resendApiKey", "remoteImages", "spamScore", "aiSpam", "systemFrom", "memberLogin"].some((k) => k in body);
  if (adminOnly && !admin) return c.json({ error: "只有管理员可以修改这些设置" }, 403);
  if ("resendApiKey" in body) {
    const key = body.resendApiKey?.trim();
    if (!key) await setSetting(c.env, "resend_api_key", null);
    else {
      if (!key.startsWith("re_")) return c.json({ error: "Resend API Key 应以 re_ 开头" }, 400);
      await setSetting(c.env, "resend_api_key", await encrypt(c.env, key));
    }
  }
  if (body.remoteImages) await setSetting(c.env, "pref_remote_images", body.remoteImages === "always" ? "always" : "ask");
  if ("spamScore" in body) {
    const v = body.spamScore === null || body.spamScore === "" ? null : String(Number(body.spamScore));
    if (v !== null && Number.isNaN(Number(v))) return c.json({ error: "评分阈值必须是数字" }, 400);
    await setSetting(c.env, "pref_spam_score", v);
  }
  if ("aiSpam" in body) await setSetting(c.env, "pref_ai_spam", body.aiSpam ? "1" : null);
  if ("memberLogin" in body) await setSetting(c.env, "pref_member_login", body.memberLogin ? null : "off");
  if ("systemFrom" in body) {
    const v = body.systemFrom?.trim().toLowerCase() || null;
    if (v && !isEmail(v)) return c.json({ error: "系统发件地址无效" }, 400);
    await setSetting(c.env, "system_from", v);
  }
  if (body.trustSender || body.untrustSender) {
    const list = new Set(await trustedSenders(c.env));
    if (body.trustSender) list.add(body.trustSender.toLowerCase());
    if (body.untrustSender) list.delete(body.untrustSender.toLowerCase());
    await setSetting(c.env, "pref_trusted_senders", JSON.stringify([...list].slice(-1000)));
  }
  return c.json({ ok: true });
});
