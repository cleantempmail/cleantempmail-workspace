import { Hono, type Context, type Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Cf, CfApiError } from "./cf";
import type { AppEnv, Env, Session } from "./env";
import { sendVia, type Provider } from "./providers";
import { FULL, parseScope } from "./scope";
import { clearFailures, hashPassword, newChallenge, passwordProblem, recordFailure, tooManyAttempts, verifyAssertion, verifyPassword } from "./local-auth";
import { decrypt, domainOf, encrypt, getSetting, getSettings, isEmail, now, randomId, setSetting, sha256hex, workerName } from "./util";

const AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";

// 创建 OAuth client 时需要勾选同样的 scope（见 README / scripts/create-oauth-client.sh）
export const SCOPES = [
  "offline_access", // 获取 refresh token
  "user-details.read",
  "account-settings.read",
  "workers-scripts.metadata_read",
  "zone.read",
  "zone-settings.write",
  "dns.read",
  "dns.write",
  "email-routing-rule.read",
  "email-routing-rule.write",
  "email-sending.read",
  "email-sending.write",
];
// 可选：用于查询外发邮件的投递状态。OAuth 客户端没有勾选时会自动退回不带它的登录。
export const OPTIONAL_SCOPES = ["analytics.read"];

const SESSION_TTL = 30 * 24 * 3600;
const MEMBER_LINK_TTL = 15 * 60;

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

export const oauthConfigured = (env: Env) => Boolean(env.CF_OAUTH_CLIENT_ID && env.CF_OAUTH_CLIENT_SECRET);

// 本地开发判断：wrangler dev 配了自定义域名路由时会改写 URL 的主机名，所以同时看客户端 IP。
// 线上的 CF-Connecting-IP 由 Cloudflare 写入，客户端无法伪造成回环地址。
const LOOPBACK = ["127.0.0.1", "::1", "localhost"];
const isLocal = (c: Context<AppEnv>) =>
  LOOPBACK.includes(new URL(c.req.url).hostname) || LOOPBACK.includes(c.req.header("cf-connecting-ip") ?? "");
const devLogin = (c: Context<AppEnv>) => c.env.DEV_LOGIN === "1" && isLocal(c);

// 线上用 __Host- 前缀（强制 Secure、Path=/、不能设 Domain，子域名无法覆盖）；本地 http 用普通名字
const cookieName = (c: Context<AppEnv>) => (isLocal(c) ? "sid" : "__Host-sid");
const readSid = (c: Context<AppEnv>) => getCookie(c, "__Host-sid") ?? getCookie(c, "sid") ?? null;

function redirectUri(c: Context<AppEnv>) {
  return new URL("/auth/callback", c.req.url).toString();
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.CF_OAUTH_CLIENT_ID}:${env.CF_OAUTH_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(params),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(`OAuth token 请求失败：${data.error_description ?? data.error ?? res.status}`) as Error & { code?: string };
    err.code = data.error;
    throw err;
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? params.refresh_token,
    expires_at: now() + (data.expires_in ?? 3600) - 60,
    scope: data.scope,
  };
}

async function createSession(c: Context<AppEnv>, userId: string, email: string | null, tokens: Tokens | null) {
  const sid = randomId(32);
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, email, tokens, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256hex(sid), userId, email, tokens ? await encrypt(c.env, JSON.stringify(tokens)) : null, now() + SESSION_TTL, now())
    .run();
  setCookie(c, cookieName(c), sid, { httpOnly: true, secure: !isLocal(c), sameSite: "Lax", path: "/", maxAge: SESSION_TTL });
}

// 第一个登录的人成为这套邮箱的主人（管理员）
async function checkOwner(env: Env, userId: string): Promise<boolean> {
  const owner = await getSetting(env, "owner_user_id");
  if (!owner) {
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('owner_user_id', ?)").bind(userId).run();
    return (await getSetting(env, "owner_user_id")) === userId;
  }
  return owner === userId;
}

// ---------- CSRF：只接受同源的写请求 ----------
// 本应用与公开站同属一个主域，SameSite=Lax 挡不住同站（兄弟子域）的请求，所以显式校验来源。
export async function csrf(c: Context<AppEnv>, next: Next) {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    const ok = site ? site === "same-origin" || site === "none" : !origin || origin === new URL(c.req.url).origin;
    if (!ok) return c.json({ error: "跨站请求已被拒绝" }, 403);
    // JSON 接口必须声明 application/json（表单和 text/plain 都属于"简单请求"，可被跨站提交）
    const ct = c.req.header("content-type") ?? "";
    const isUpload = c.req.path === "/api/uploads";
    if (!isUpload && c.req.path.startsWith("/api/") && m !== "DELETE" && !ct.includes("application/json")) {
      return c.json({ error: "请求格式错误" }, 415);
    }
  }
  await next();
}

export const auth = new Hono<AppEnv>();

auth.get("/login", async (c) => {
  if (devLogin(c)) {
    await checkOwner(c.env, "dev-user");
    await createSession(c, "dev-user", "dev@localhost", null);
    return c.redirect("/");
  }
  if (!oauthConfigured(c.env)) return c.redirect("/");
  const basic = c.req.query("basic") === "1";
  const state = randomId(16);
  setCookie(c, "oauth_state", `${state}.${basic ? 1 : 0}`, { httpOnly: true, secure: true, sameSite: "Lax", path: "/auth", maxAge: 600 });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: c.env.CF_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(c),
    scope: (basic ? SCOPES : [...SCOPES, ...OPTIONAL_SCOPES]).join(" "),
    state,
  }).toString();
  return c.redirect(url.toString());
});

auth.get("/callback", async (c) => {
  const { code, state, error, error_description } = c.req.query();
  const [savedState, basic] = (getCookie(c, "oauth_state") ?? "").split(".");
  // OAuth 客户端没有勾选可选权限时，自动用基础权限重试
  if (error === "invalid_scope" && basic !== "1") return c.redirect("/auth/login?basic=1");
  if (error) return c.text(`授权失败：${error_description ?? error}`, 400);
  if (!code || !state || state !== savedState) return c.text("state 校验失败，请重新登录", 400);
  deleteCookie(c, "oauth_state", { path: "/auth" });

  const tokens = await tokenRequest(c.env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(c) });
  const user = await new Cf(tokens.access_token).user();
  if (!(await checkOwner(c.env, user.id))) {
    return c.text("这套邮箱已绑定到另一个 Cloudflare 用户。团队成员请在登录页使用「成员登录」。", 403);
  }
  await createSession(c, user.id, user.email, tokens);
  return c.redirect("/");
});

// ---------- 不依赖 OAuth 的管理员登录 ----------
const clientIp = (c: Context<AppEnv>) => c.req.header("cf-connecting-ip") ?? "unknown";
const rpOf = (c: Context<AppEnv>) => {
  const u = new URL(c.req.url);
  return { rpId: u.hostname, origin: u.origin };
};

// 首次设置：粘贴 API 令牌 + 设置管理员密码。
// 令牌必须能看到部署了本 Worker 的账户——这就证明了操作的人是账户主人，别人无法抢先认领。
auth.post("/setup", async (c) => {
  const body = await c.req.json<{ token?: string; password?: string }>().catch(() => ({}) as { token?: string; password?: string });
  if (await getSetting(c.env, "owner_user_id")) return c.json({ error: "管理员已经设置过了，请直接登录" }, 409);
  const bad = passwordProblem(body.password);
  if (bad) return c.json({ error: bad }, 400);
  const token = String(body.token ?? "").trim();
  if (!/^[\w.-]{20,}$/.test(token)) return c.json({ error: "API 令牌格式不对，请粘贴完整的令牌" }, 400);
  const checked = await checkApiToken(c.env, token, true).catch((e: Error) => e);
  if (checked instanceof Error) return c.json({ error: checked.message }, 400);
  const { ownerId, email, accountId, warnings } = checked;
  await c.env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('owner_user_id', ?)").bind(ownerId).run();
  if ((await getSetting(c.env, "owner_user_id")) !== ownerId) return c.json({ error: "管理员已经设置过了，请直接登录" }, 409);
  await Promise.all([
    setSetting(c.env, "account_id", accountId),
    setSetting(c.env, "owner_email", email),
    setSetting(c.env, "cf_api_token", await encrypt(c.env, token)),
    setSetting(c.env, "admin_password", await hashPassword(body.password!)),
  ]);
  await createSession(c, ownerId, email, null);
  return c.json({ ok: true, warnings });
});

auth.post("/password", async (c) => {
  const ip = clientIp(c);
  if (await tooManyAttempts(c.env, ip)) return c.json({ error: "尝试次数太多，请 15 分钟后再试" }, 429);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  const st = await getSettings(c.env, ["owner_user_id", "admin_password", "owner_email"]);
  if (!st.owner_user_id || !st.admin_password) return c.json({ error: "还没有设置管理员密码" }, 400);
  if (!(await verifyPassword(String(password ?? ""), st.admin_password))) {
    await recordFailure(c.env, ip);
    return c.json({ error: "密码不正确" }, 401);
  }
  await clearFailures(c.env, ip);
  await createSession(c, st.owner_user_id, st.owner_email, null);
  return c.json({ ok: true });
});

// 忘记密码：用同一个 Cloudflare 账户的 API 令牌证明身份后重设
auth.post("/reset", async (c) => {
  const ip = clientIp(c);
  if (await tooManyAttempts(c.env, ip)) return c.json({ error: "尝试次数太多，请 15 分钟后再试" }, 429);
  const body = await c.req.json<{ token?: string; password?: string }>().catch(() => ({}) as { token?: string; password?: string });
  const st = await getSettings(c.env, ["owner_user_id", "owner_email", "account_id"]);
  if (!st.owner_user_id) return c.json({ error: "还没有设置管理员，请先完成首次设置" }, 400);
  const bad = passwordProblem(body.password);
  if (bad) return c.json({ error: bad }, 400);
  const token = String(body.token ?? "").trim();
  const checked = /^[\w.-]{20,}$/.test(token) ? await checkApiToken(c.env, token, true).catch((e: Error) => e) : new Error("API 令牌格式不对，请粘贴完整的令牌");
  if (checked instanceof Error) {
    await recordFailure(c.env, ip);
    return c.json({ error: checked.message }, 400);
  }
  if (st.account_id && checked.accountId !== st.account_id) {
    await recordFailure(c.env, ip);
    return c.json({ error: "这个令牌属于另一个 Cloudflare 账户" }, 400);
  }
  await Promise.all([setSetting(c.env, "admin_password", await hashPassword(body.password!)), setSetting(c.env, "cf_api_token", await encrypt(c.env, token))]);
  // 旧会话全部失效
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(st.owner_user_id).run();
  await clearFailures(c.env, ip);
  await createSession(c, st.owner_user_id, st.owner_email, null);
  return c.json({ ok: true, warnings: checked.warnings });
});

auth.post("/passkey/begin", async (c) => {
  const owner = await getSetting(c.env, "owner_user_id");
  const { results } = owner ? await c.env.DB.prepare("SELECT id FROM passkeys WHERE user_id = ?").bind(owner).all<{ id: string }>() : { results: [] };
  if (!results.length) return c.json({ error: "还没有添加通行密钥" }, 400);
  return c.json({ challenge: await newChallenge(c.env, "login"), rpId: rpOf(c).rpId, allowCredentials: results.map((r) => r.id) });
});

auth.post("/passkey/finish", async (c) => {
  const ip = clientIp(c);
  if (await tooManyAttempts(c.env, ip)) return c.json({ error: "尝试次数太多，请 15 分钟后再试" }, 429);
  const body = await c.req.json<{ id: string; clientDataJSON: string; authenticatorData: string; signature: string }>();
  const st = await getSettings(c.env, ["owner_user_id", "owner_email"]);
  const row = await c.env.DB.prepare("SELECT id, user_id, public_key, alg, sign_count FROM passkeys WHERE id = ?")
    .bind(String(body.id ?? ""))
    .first<{ id: string; user_id: string; public_key: string; alg: number; sign_count: number }>();
  if (!row || row.user_id !== st.owner_user_id) {
    await recordFailure(c.env, ip);
    return c.json({ error: "这个通行密钥不属于管理员" }, 401);
  }
  const { rpId, origin } = rpOf(c);
  try {
    const count = await verifyAssertion(c.env, body, { jwk: JSON.parse(row.public_key), alg: row.alg, signCount: row.sign_count }, rpId, origin);
    await c.env.DB.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?").bind(count, now(), row.id).run();
  } catch (e: any) {
    await recordFailure(c.env, ip);
    return c.json({ error: e.message }, 401);
  }
  await clearFailures(c.env, ip);
  await createSession(c, row.user_id, st.owner_email, null);
  return c.json({ ok: true });
});

// 检查 API 令牌：能找到部署了本 Worker 的账户；顺便检查读取域名的权限。
// strict：必须真的找到本 Worker（本地开发时 Worker 可能还没部署，放宽）
export async function checkApiToken(env: Env, token: string, strict: boolean) {
  const cf = new Cf(token);
  const user = await cf.user().catch(() => null);
  const verify = await cf.get<{ id: string; status: string }>("/user/tokens/verify").catch(() => null);
  if (verify && verify.status !== "active") throw new Error("这个令牌已停用或过期");
  let accountId: string;
  try {
    accountId = await workerAccountId(env, cf, { strict: strict && env.DEV_LOGIN !== "1", cache: false });
  } catch (e: any) {
    throw new Error(
      e instanceof CfApiError && (e.status === 401 || e.status === 403)
        ? "令牌无效，或者缺少「账户设置：读取」「Workers 脚本：读取」权限"
        : e.message,
    );
  }
  const warnings: string[] = [];
  if (!(await cf.get(`/zones?account.id=${accountId}&per_page=1`).then(() => true, () => false))) warnings.push("令牌没有「区域：读取」权限，添加域名时会失败，请在 Cloudflare 里给令牌补上");
  const ownerId = user?.id ?? `token:${verify?.id ?? (await sha256hex(token)).slice(0, 24)}`;
  return { ownerId, email: user?.email ?? null, accountId, warnings };
}

// ---------- 团队成员：邮件登录链接 ----------

auth.post("/magic", async (c) => {
  const { email } = await c.req.json<{ email: string }>().catch(() => ({ email: "" }));
  const addr = (email ?? "").trim().toLowerCase();
  // 无论成员是否存在都返回同样的结果，避免被用来探测成员名单
  const generic = c.json({ ok: true });
  if (!isEmail(addr)) return generic;
  const member = await c.env.DB.prepare(
    "SELECT id, name, (SELECT value FROM settings WHERE key = 'pref_member_login') AS pref FROM members WHERE email = ? AND disabled = 0",
  ).bind(addr).first<{ id: string; name: string | null; pref: string | null }>();
  if (!member || member.pref === "off") return generic;
  // 同一成员 1 分钟内只发一次
  const recent = await c.env.DB.prepare("SELECT 1 FROM login_tokens WHERE member_id = ? AND expires_at > ?")
    .bind(member.id, now() + MEMBER_LINK_TTL - 60)
    .first();
  if (recent) return generic;
  const token = randomId(32);
  await c.env.DB.prepare("INSERT INTO login_tokens (hash, member_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256hex(token), member.id, now() + MEMBER_LINK_TTL)
    .run();
  const link = new URL(`/auth/magic/${token}`, c.req.url).toString();
  c.executionCtx.waitUntil(
    sendSystemMail(c.env, addr, "登录 CleanTempMail Workspace", `你好${member.name ? " " + member.name : ""}：\n\n点击下面的链接登录（15 分钟内有效，只能使用一次）：\n${link}\n\n如果不是你本人操作，请忽略这封邮件。`).catch((e) =>
      console.warn("magic link send failed", e),
    ),
  );
  return generic;
});

auth.get("/magic/:token", async (c) => {
  const hash = await sha256hex(c.req.param("token"));
  const row = await c.env.DB.prepare(
    "UPDATE login_tokens SET used = 1 WHERE hash = ? AND used = 0 AND expires_at > ? RETURNING member_id",
  ).bind(hash, now()).first<{ member_id: string }>();
  if (!row) return c.text("登录链接无效或已过期，请重新获取。", 400);
  const m = await c.env.DB.prepare("SELECT id, email FROM members WHERE id = ? AND disabled = 0").bind(row.member_id).first<{ id: string; email: string }>();
  if (!m) return c.text("该成员已被停用。", 403);
  await c.env.DB.prepare("UPDATE members SET last_login_at = ? WHERE id = ?").bind(now(), m.id).run();
  await createSession(c, "member:" + m.id, m.email, null);
  return c.redirect("/");
});

// 系统邮件（登录链接、邀请）：用设置里的系统发件地址，默认第一个已开通发件的域名
export async function sendSystemMail(env: Env, to: string, subject: string, text: string): Promise<void> {
  let from = await getSetting(env, "system_from");
  let provider: Provider = "none";
  if (from) {
    provider = (await env.DB.prepare("SELECT send_provider FROM domains WHERE name = ?").bind(domainOf(from)).first<{ send_provider: Provider }>())?.send_provider ?? "none";
  }
  if (!from || provider === "none") {
    const d = await env.DB.prepare("SELECT name, send_provider FROM domains WHERE send_provider != 'none' ORDER BY send_status = 'active' DESC, name LIMIT 1").first<{ name: string; send_provider: Provider }>();
    if (!d) throw new Error("没有可用的发件域名");
    from = `noreply@${d.name}`;
    provider = d.send_provider;
  }
  await sendVia(env, provider, { from: { email: from, name: "CleanTempMail Workspace" }, to: [to], cc: [], bcc: [], subject, text, headers: {}, attachments: [] });
}

auth.post("/logout", async (c) => {
  const sid = readSid(c);
  if (sid) {
    const id = await sha256hex(sid);
    const row = await c.env.DB.prepare("SELECT tokens FROM sessions WHERE id = ?").bind(id).first<{ tokens: string | null }>();
    if (row?.tokens && oauthConfigured(c.env)) {
      try {
        const t: Tokens = JSON.parse(await decrypt(c.env, row.tokens));
        c.executionCtx.waitUntil(
          fetch(REVOKE_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: "Basic " + btoa(`${c.env.CF_OAUTH_CLIENT_ID}:${c.env.CF_OAUTH_CLIENT_SECRET}`),
            },
            body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }),
          }).catch(() => {}),
        );
      } catch {}
    }
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  }
  deleteCookie(c, "__Host-sid", { path: "/", secure: true });
  deleteCookie(c, "sid", { path: "/" });
  return c.json({ ok: true });
});

// ---------- 会话 ----------

interface SessionRow {
  id: string;
  user_id: string;
  email: string | null;
  tokens: string | null;
  owner: string | null;
  m_scope: string | null;
  m_disabled: number | null;
  api: number;
}

export async function loadSession(c: Context<AppEnv>): Promise<Session | null> {
  const sid = readSid(c);
  if (!sid) return null;
  // 会话、主人设置、成员信息一次查询取回（每个请求都要执行，必须只有一次往返）
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.email, s.tokens, (SELECT value FROM settings WHERE key = 'owner_user_id') AS owner,
       EXISTS (SELECT 1 FROM settings WHERE key = 'cf_api_token') AS api,
       m.scope AS m_scope, m.disabled AS m_disabled
     FROM sessions s LEFT JOIN members m ON s.user_id = 'member:' || m.id
     WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(await sha256hex(sid), now())
    .first<SessionRow>();
  if (!row) return null;
  if (row.user_id.startsWith("member:")) {
    if (row.m_scope === null || row.m_disabled) return null;
    return { id: row.id, userId: row.user_id, email: row.email, role: "member", scope: parseScope(row.m_scope), hasCfToken: false };
  }
  // 管理员必须仍是主人（防止换绑后旧会话继续有效）
  if (row.owner && row.owner !== row.user_id) return null;
  return { id: row.id, userId: row.user_id, email: row.email, role: "admin", scope: FULL, hasCfToken: Boolean(row.tokens) || Boolean(row.api) || devLogin(c), tokens: row.tokens };
}

export async function requireSession(c: Context<AppEnv>, next: Next) {
  const session = await loadSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  c.set("session", session);
  await next();
}

export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  if (c.get("session")?.role !== "admin") return c.json({ error: "只有管理员可以进行此操作" }, 403);
  await next();
}

// 取可用的 access token：过期时用 refresh token 换新。
// 用"条件更新"避免并发刷新互相覆盖；refresh token 失效后清掉它，之后不再反复重试。
async function accessTokenFor(env: Env, sessionId: string): Promise<{ token: string; scope?: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await env.DB.prepare("SELECT tokens FROM sessions WHERE id = ?").bind(sessionId).first<{ tokens: string | null }>();
    if (!row?.tokens) return null;
    let tokens: Tokens;
    try {
      tokens = JSON.parse(await decrypt(env, row.tokens));
    } catch {
      return null;
    }
    if (tokens.expires_at > now()) return { token: tokens.access_token, scope: tokens.scope };
    if (!tokens.refresh_token) return null;
    try {
      const fresh = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      fresh.scope ??= tokens.scope;
      const res = await env.DB.prepare("UPDATE sessions SET tokens = ? WHERE id = ? AND tokens = ?")
        .bind(await encrypt(env, JSON.stringify(fresh)), sessionId, row.tokens)
        .run();
      if (res.meta.changes) return { token: fresh.access_token, scope: fresh.scope };
      // 另一个请求已经刷新过，重新读取
    } catch (e: any) {
      if (e?.code === "invalid_grant") {
        delete tokens.refresh_token;
        await env.DB.prepare("UPDATE sessions SET tokens = ? WHERE id = ? AND tokens = ?")
          .bind(await encrypt(env, JSON.stringify(tokens)), sessionId, row.tokens)
          .run();
      }
      return null;
    }
  }
  return null;
}

export async function cfClient(c: Context<AppEnv>): Promise<Cf> {
  const s = c.get("session");
  if (s.role !== "admin") throw new ReauthError("只有管理员可以管理域名");
  if (devLogin(c) && c.env.DEV_CF_API_TOKEN) return new Cf(c.env.DEV_CF_API_TOKEN);
  const api = await apiTokenCf(c.env);
  if (api) return api;
  const t = await accessTokenFor(c.env, s.id);
  if (!t) throw new ReauthError();
  return new Cf(t.token);
}

// 只读取已保存的授权范围，不刷新 token（刷新要访问 Cloudflare，会让页面变慢）
export async function sessionTokenScope(c: Context<AppEnv>): Promise<string | null> {
  const enc = c.get("session").tokens;
  if (!enc) return null;
  try {
    return (JSON.parse(await decrypt(c.env, enc)) as Tokens).scope ?? null;
  } catch {
    return null;
  }
}

// 首次设置时保存的 API 令牌（不需要 OAuth）
async function apiTokenCf(env: Env): Promise<Cf | null> {
  const enc = await getSetting(env, "cf_api_token");
  if (!enc) return null;
  try {
    return new Cf(await decrypt(env, enc));
  } catch {
    return null;
  }
}

// 定时任务没有请求上下文：优先用 API 令牌，否则用管理员最近一次的 OAuth 会话
export async function ownerCf(env: Env): Promise<{ cf: Cf; scope?: string } | null> {
  const api = await apiTokenCf(env);
  if (api) return { cf: api };
  const owner = await getSetting(env, "owner_user_id");
  if (!owner) return null;
  const { results } = await env.DB.prepare(
    "SELECT id FROM sessions WHERE user_id = ? AND tokens IS NOT NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 3",
  ).bind(owner, now()).all<{ id: string }>();
  for (const r of results) {
    const t = await accessTokenFor(env, r.id);
    if (t) return { cf: new Cf(t.token), scope: t.scope };
  }
  return null;
}

export class ReauthError extends Error {
  constructor(msg = "Cloudflare 授权已过期，请重新登录") {
    super(msg);
  }
}

// 找到部署了本 Worker 的账户：catch-all 只能投递给同账户的 Worker，发件绑定也属于该账户
export async function workerAccountId(env: Env, cf: Cf, opts: { strict?: boolean; cache?: boolean } = {}): Promise<string> {
  const cached = opts.cache === false ? null : await getSetting(env, "account_id");
  if (cached) return cached;
  const accounts = await cf.accounts();
  const names = [...new Set([await workerName(env), env.WORKER_NAME])];
  for (const a of accounts) {
    for (const name of names) {
      if (await cf.workerExists(a.id, name).catch(() => false)) {
        if (opts.cache !== false) await setSetting(env, "account_id", a.id);
        return a.id;
      }
    }
  }
  if (accounts.length === 1 && !opts.strict) return accounts[0].id; // 本地开发时 Worker 尚未部署
  throw new Error(
    `在你授权的账户中没有找到名为 ${names.join(" 或 ")} 的 Worker。请授权部署了本应用的那个账户；如果部署时改了 Worker 名称，请先通过 workers.dev 地址打开一次本应用，或把变量 WORKER_NAME 改成新名称`,
  );
}

export async function purgeExpiredSessions(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
    env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?").bind(now() - 86400),
  ]);
}
