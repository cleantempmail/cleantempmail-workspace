import type { Env } from "./env";

export const now = () => Math.floor(Date.now() / 1000);

export function randomId(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

// 一次查询读取多个设置（每次查询都是一次网络往返，能合并就合并）
export async function getSettings<K extends string>(env: Env, keys: K[]): Promise<Record<K, string | null>> {
  const out = Object.fromEntries(keys.map((k) => [k, null])) as Record<K, string | null>;
  if (!keys.length) return out;
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .all<{ key: K; value: string }>();
  for (const r of results) out[r.key] = r.value;
  return out;
}

export async function setSetting(env: Env, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(key, value).run();
  }
}

// 加密密钥：优先用 Worker Secret APP_SECRET（与数据分离存放）；未设置时退回存在 D1 里的随机密钥。
// 新格式密文以 "v2:" 开头；旧格式仍可解密，重新写入时自动升级。
const keyCache = new Map<string, CryptoKey>();
async function legacySecret(env: Env): Promise<string> {
  let secret = await getSetting(env, "app_secret");
  if (!secret) {
    secret = b64encode(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('app_secret', ?)").bind(secret).run();
    secret = (await getSetting(env, "app_secret"))!;
  }
  return secret;
}
async function legacyKey(env: Env): Promise<CryptoKey> {
  const hit = keyCache.get("legacy");
  if (hit) return hit;
  const key = await crypto.subtle.importKey("raw", b64decode(await legacySecret(env)), "AES-GCM", false, ["encrypt", "decrypt"]);
  keyCache.set("legacy", key);
  return key;
}
async function secretKey(env: Env): Promise<CryptoKey> {
  const hit = keyCache.get("v2");
  if (hit) return hit;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cfm-v2:" + env.APP_SECRET));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  keyCache.set("v2", key);
  return key;
}

export async function encrypt(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const v2 = Boolean(env.APP_SECRET);
  const key = v2 ? await secretKey(env) : await legacyKey(env);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${v2 ? "v2:" : ""}${b64encode(iv)}.${b64encode(ct)}`;
}

export async function decrypt(env: Env, data: string): Promise<string> {
  const v2 = data.startsWith("v2:");
  if (v2 && !env.APP_SECRET) throw new Error("缺少 APP_SECRET，无法解密");
  const [iv, ct] = (v2 ? data.slice(3) : data).split(".");
  const key = v2 ? await secretKey(env) : await legacyKey(env);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv) }, key, b64decode(ct));
  return new TextDecoder().decode(pt);
}

export const isLegacyCipher = (data: string) => !data.startsWith("v2:");

export async function sha256hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const buf = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  return b64encode(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return b64decode(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export const isEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

export function snippetOf(text: string | undefined | null, len = 160): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, len);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// HMAC 签名（图片代理链接用）：与加密密钥同源，但用途前缀不同
export async function hmacSign(env: Env, data: string): Promise<string> {
  let key = keyCache.get("hmac");
  if (!key) {
    const material = env.APP_SECRET ? "cfm-hmac:" + env.APP_SECRET : "cfm-hmac-legacy:" + (await legacySecret(env));
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set("hmac", key);
  }
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig).slice(0, 16));
}

// 本 Worker 的名称：Catch-all 按名称把邮件投递给 Worker。一键部署时用户可以改名，而 vars.WORKER_NAME 不会跟着变，
// 所以通过 <名称>.<子域>.workers.dev 访问时，从地址里识别真实名称并记下来（自定义域名访问时沿用已记下的或 WORKER_NAME）
let seenWorkerName: string | null = null;
export function noteWorkerHost(env: Env, host: string): Promise<unknown> | null {
  const m = host.toLowerCase().match(/^(?:[0-9a-f]{8}-)?([a-z0-9][a-z0-9-]*)\.[a-z0-9-]+\.workers\.dev$/);
  if (!m || m[1] === seenWorkerName) return null;
  seenWorkerName = m[1];
  return env.DB.prepare("INSERT INTO settings (key, value) VALUES ('worker_name', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value != excluded.value")
    .bind(m[1])
    .run()
    .catch(() => {});
}
export async function workerName(env: Env): Promise<string> {
  return (await getSetting(env, "worker_name")) ?? env.WORKER_NAME;
}

// 记录本次部署使用的存储方式（只记第一次）：部署脚本据此保持存储方式不变，避免开通 R2 后旧邮件读不到
let storageNoted = false;
export function noteStorageMode(env: Env): Promise<unknown> | null {
  if (storageNoted) return null;
  storageNoted = true;
  return env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('storage_mode', ?)")
    .bind(env.MAIL ? "r2" : "lite")
    .run()
    .catch(() => {});
}
