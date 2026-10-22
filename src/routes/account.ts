// 管理员账户与安全：密码、通行密钥、Cloudflare API 令牌
import { Hono } from "hono";
import { checkApiToken, oauthConfigured, requireAdmin } from "../auth";
import type { AppEnv } from "../env";
import { hashPassword, newChallenge, passwordProblem, verifyPassword, verifyRegistration } from "../local-auth";
import { encrypt, getSetting, getSettings, now, setSetting } from "../util";

export const account = new Hono<AppEnv>();
account.use("/account/*", requireAdmin);
account.use("/account", requireAdmin);

const rpOf = (url: string) => {
  const u = new URL(url);
  return { rpId: u.hostname, origin: u.origin };
};

account.get("/account", async (c) => {
  const s = c.get("session");
  const [st, { results }] = await Promise.all([
    getSettings(c.env, ["admin_password", "cf_api_token", "owner_email"]),
    c.env.DB.prepare("SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at").bind(s.userId).all(),
  ]);
  return c.json({
    hasPassword: Boolean(st.admin_password),
    passkeys: results,
    cfToken: Boolean(st.cf_api_token),
    oauthConfigured: oauthConfigured(c.env),
    email: st.owner_email ?? s.email,
  });
});

account.put("/account/password", async (c) => {
  const { current, next } = await c.req.json<{ current?: string; next?: string }>();
  const stored = await getSetting(c.env, "admin_password");
  if (stored && !(await verifyPassword(String(current ?? ""), stored))) return c.json({ error: "当前密码不正确" }, 400);
  const bad = passwordProblem(next);
  if (bad) return c.json({ error: bad }, 400);
  await setSetting(c.env, "admin_password", await hashPassword(next!));
  // 其他设备上用旧密码登录的会话一并退出
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(c.get("session").userId, c.get("session").id).run();
  return c.json({ ok: true });
});

// 添加通行密钥：返回创建参数
account.post("/account/passkeys/begin", async (c) => {
  const s = c.get("session");
  const { results } = await c.env.DB.prepare("SELECT id FROM passkeys WHERE user_id = ?").bind(s.userId).all<{ id: string }>();
  const { rpId } = rpOf(c.req.url);
  return c.json({
    challenge: await newChallenge(c.env, "register"),
    rp: { id: rpId, name: "CleanTempMail Workspace" },
    user: { id: s.userId, name: s.email || "admin", displayName: s.email || "管理员" },
    excludeCredentials: results.map((r) => r.id),
  });
});

account.post("/account/passkeys", async (c) => {
  const s = c.get("session");
  const body = await c.req.json<{ id: string; clientDataJSON: string; attestationObject: string; name?: string }>();
  const { rpId, origin } = rpOf(c.req.url);
  try {
    const pk = await verifyRegistration(c.env, body, rpId, origin);
    await c.env.DB.prepare("INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(pk.id, s.userId, JSON.stringify(pk.jwk), pk.alg, pk.signCount, String(body.name ?? "").slice(0, 60) || null, now())
      .run();
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
  return c.json({ ok: true });
});

account.delete("/account/passkeys/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("session").userId).run();
  return c.json({ ok: true });
});

// 更换 Cloudflare API 令牌：必须属于同一个账户
account.put("/account/cf-token", async (c) => {
  const { token } = await c.req.json<{ token?: string }>();
  const t = String(token ?? "").trim();
  if (!/^[\w.-]{20,}$/.test(t)) return c.json({ error: "API 令牌格式不对，请粘贴完整的令牌" }, 400);
  const checked = await checkApiToken(c.env, t, true).catch((e: Error) => e);
  if (checked instanceof Error) return c.json({ error: checked.message }, 400);
  const current = await getSetting(c.env, "account_id");
  if (current && current !== checked.accountId) return c.json({ error: "这个令牌属于另一个 Cloudflare 账户" }, 400);
  await setSetting(c.env, "cf_api_token", await encrypt(c.env, t));
  return c.json({ ok: true, warnings: checked.warnings });
});

account.delete("/account/cf-token", async (c) => {
  if (!oauthConfigured(c.env)) return c.json({ error: "没有配置 OAuth，移除令牌后将无法管理域名。可以直接更换令牌" }, 400);
  await setSetting(c.env, "cf_api_token", null);
  return c.json({ ok: true });
});
