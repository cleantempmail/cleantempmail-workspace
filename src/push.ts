// Web Push：页面关掉也能收到新邮件通知
// 发送"空推送"（只需 VAPID 签名，无需加密正文），Service Worker 收到后自己拉取最新邮件生成通知。
import type { Env } from "./env";
import { canUseAddress, parseScope } from "./scope";
import { b64url, decrypt, encrypt, getSetting, getSettings, now, setSetting } from "./util";

async function vapidKeys(env: Env): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const st = await getSettings(env, ["vapid_public", "vapid_private"]);
  let pub = st.vapid_public;
  let privEnc = st.vapid_private;
  if (!pub || !privEnc) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    pub = b64url(raw);
    privEnc = await encrypt(env, JSON.stringify(jwk));
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid_public', ?)").bind(pub),
      env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid_private', ?)").bind(privEnc),
    ]);
    // 并发初始化时以先写入的为准
    pub = (await getSetting(env, "vapid_public"))!;
    privEnc = (await getSetting(env, "vapid_private"))!;
  }
  const jwk = JSON.parse(await decrypt(env, privEnc));
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { publicKey: pub, privateKey };
}

export async function vapidPublicKey(env: Env): Promise<string> {
  return (await vapidKeys(env)).publicKey;
}

async function vapidAuth(env: Env, endpoint: string, subject: string): Promise<string> {
  const { publicKey, privateKey } = await vapidKeys(env);
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: now() + 12 * 3600, sub: subject })}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${publicKey}`;
}

// 给能看到这封邮件的用户推送
export async function notifyNewMail(env: Env, mailbox: string, origin: string | null): Promise<void> {
  const { results } = await env.DB.prepare("SELECT endpoint, user_id FROM push_subs").all<{ endpoint: string; user_id: string }>();
  if (!results.length) return;
  const memberScopes = new Map<string, ReturnType<typeof parseScope> | null>();
  const subject = `mailto:${(await getSetting(env, "system_from")) ?? "admin@" + (origin ? new URL(origin).hostname : "localhost")}`;
  await Promise.all(
    results.map(async (s) => {
      if (s.user_id.startsWith("member:")) {
        if (!memberScopes.has(s.user_id)) {
          const row = await env.DB.prepare("SELECT scope, disabled FROM members WHERE id = ?").bind(s.user_id.slice(7)).first<{ scope: string; disabled: number }>();
          memberScopes.set(s.user_id, row && !row.disabled ? parseScope(row.scope) : null);
        }
        const scope = memberScopes.get(s.user_id);
        if (!scope || !canUseAddress(scope, mailbox)) return;
      }
      try {
        const res = await fetch(s.endpoint, {
          method: "POST",
          headers: { TTL: "86400", Urgency: "high", Authorization: await vapidAuth(env, s.endpoint, subject), "Content-Length": "0" },
        });
        if (res.status === 404 || res.status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run();
      } catch {}
    }),
  );
}

export { setSetting };
