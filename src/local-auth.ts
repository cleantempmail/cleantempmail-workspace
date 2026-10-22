// 不依赖 OAuth 的管理员登录：
// - 密码：PBKDF2-SHA256（免费版每次请求只有 10ms CPU，迭代次数取约 4ms 的量，再配合失败限流）
// - 通行密钥：WebAuthn（ES256 / RS256），只校验签名，不校验设备证明（attestation: none）
// - 登录失败限流：每个 IP 15 分钟 10 次，全局 15 分钟 100 次
import type { Env } from "./env";
import { b64url, b64urlDecode, now, randomId } from "./util";

// ---------- 密码 ----------
const PBKDF2_ITER = 25_000;
export const MIN_PASSWORD = 10;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [kind, iter, salt, hash] = (stored ?? "").split("$");
  if (kind !== "pbkdf2" || !hash) return false;
  const got = await pbkdf2(password, b64urlDecode(salt), Number(iter));
  const want = b64urlDecode(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
  if (password.length > 200) return "密码太长";
  return null;
}

// ---------- 失败限流 ----------
const WINDOW = 15 * 60;
const LIMITS = { ip: 10, global: 100 };

export async function tooManyAttempts(env: Env, ip: string): Promise<boolean> {
  const { results } = await env.DB.prepare("SELECT key, count FROM auth_attempts WHERE key IN (?, 'global') AND reset_at > ?").bind(`ip:${ip}`, now()).all<{ key: string; count: number }>();
  return results.some((r) => r.count >= (r.key === "global" ? LIMITS.global : LIMITS.ip));
}

export async function recordFailure(env: Env, ip: string): Promise<void> {
  const reset = now() + WINDOW;
  const upsert = `INSERT INTO auth_attempts (key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN reset_at > ? THEN count + 1 ELSE 1 END, reset_at = CASE WHEN reset_at > ? THEN reset_at ELSE excluded.reset_at END`;
  await env.DB.batch([
    env.DB.prepare(upsert).bind(`ip:${ip}`, reset, now(), now()),
    env.DB.prepare(upsert).bind("global", reset, now(), now()),
  ]);
}

export async function clearFailures(env: Env, ip: string): Promise<void> {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE key = ? OR reset_at <= ?").bind(`ip:${ip}`, now()).run();
}

// ---------- 通行密钥（WebAuthn） ----------
export async function newChallenge(env: Env, kind: "register" | "login"): Promise<string> {
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now()),
    env.DB.prepare("INSERT INTO auth_challenges (challenge, kind, expires_at) VALUES (?, ?, ?)").bind(challenge, kind, now() + 300),
  ]);
  return challenge;
}

async function takeChallenge(env: Env, challenge: string, kind: string): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM auth_challenges WHERE challenge = ? AND kind = ? AND expires_at > ? RETURNING challenge").bind(challenge, kind, now()).first();
  return Boolean(r);
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

async function checkClientData(env: Env, clientDataJSON: string, type: string, origin: string): Promise<{ raw: Uint8Array }> {
  const raw = b64urlDecode(clientDataJSON);
  let cd: ClientData;
  try {
    cd = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error("通行密钥数据无效");
  }
  if (cd.type !== type) throw new Error("通行密钥数据类型不对");
  if (cd.origin !== origin) throw new Error("通行密钥来源网址不匹配");
  if (!(await takeChallenge(env, cd.challenge, type === "webauthn.create" ? "register" : "login"))) throw new Error("验证已过期，请重试");
  return { raw };
}

async function checkAuthData(authData: Uint8Array, rpId: string) {
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  for (let i = 0; i < 32; i++) if (authData[i] !== rpHash[i]) throw new Error("通行密钥不属于这个网址");
  const flags = authData[32];
  if (!(flags & 0x01)) throw new Error("需要在设备上确认（User Presence）");
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  return { flags, signCount };
}

export interface NewPasskey {
  id: string;
  jwk: JsonWebKey;
  alg: number;
  signCount: number;
}

// 注册：解析 attestationObject，取出凭据 id 和公钥
export async function verifyRegistration(
  env: Env,
  body: { id: string; clientDataJSON: string; attestationObject: string },
  rpId: string,
  origin: string,
): Promise<NewPasskey> {
  await checkClientData(env, body.clientDataJSON, "webauthn.create", origin);
  const att = cborDecode(b64urlDecode(body.attestationObject)) as Map<unknown, unknown>;
  const authData = att.get("authData") as Uint8Array;
  if (!(authData instanceof Uint8Array)) throw new Error("通行密钥数据无效");
  const { flags, signCount } = await checkAuthData(authData, rpId);
  if (!(flags & 0x40)) throw new Error("通行密钥缺少凭据数据");
  let p = 37 + 16; // rpIdHash + flags + signCount + aaguid
  const idLen = (authData[p] << 8) | authData[p + 1];
  p += 2;
  const credId = authData.slice(p, p + idLen);
  p += idLen;
  const cose = cborDecode(authData.slice(p)) as Map<number, unknown>;
  const { jwk, alg } = coseToJwk(cose);
  const id = b64url(credId);
  if (id !== body.id) throw new Error("凭据 id 不一致");
  // 确认公钥能导入
  await importKey(jwk, alg);
  return { id, jwk, alg, signCount };
}

// 登录：校验签名，返回新的签名计数
export async function verifyAssertion(
  env: Env,
  body: { clientDataJSON: string; authenticatorData: string; signature: string },
  key: { jwk: JsonWebKey; alg: number; signCount: number },
  rpId: string,
  origin: string,
): Promise<number> {
  const { raw } = await checkClientData(env, body.clientDataJSON, "webauthn.get", origin);
  const authData = b64urlDecode(body.authenticatorData);
  const { signCount } = await checkAuthData(authData, rpId);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData);
  signed.set(clientHash, authData.length);
  let sig = b64urlDecode(body.signature);
  if (key.alg === -7) sig = derToRaw(sig);
  const pub = await importKey(key.jwk, key.alg);
  const algo = key.alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  if (!(await crypto.subtle.verify(algo, pub, sig, signed))) throw new Error("通行密钥签名无效");
  // 计数器倒退说明凭据可能被复制（很多同步型通行密钥始终为 0，不判断）
  if (signCount !== 0 && key.signCount !== 0 && signCount <= key.signCount) throw new Error("通行密钥计数异常，请重新添加");
  return signCount;
}

function importKey(jwk: JsonWebKey, alg: number): Promise<CryptoKey> {
  if (alg === -7) return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (alg === -257) return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  throw new Error("不支持的通行密钥算法");
}

function coseToJwk(cose: Map<number, unknown>): { jwk: JsonWebKey; alg: number } {
  const kty = cose.get(1);
  const alg = cose.get(3) as number;
  if (kty === 2 && cose.get(-1) === 1) {
    return { alg: -7, jwk: { kty: "EC", crv: "P-256", x: b64url(cose.get(-2) as Uint8Array), y: b64url(cose.get(-3) as Uint8Array), ext: true } };
  }
  if (kty === 3) return { alg: -257, jwk: { kty: "RSA", n: b64url(cose.get(-1) as Uint8Array), e: b64url(cose.get(-2) as Uint8Array), alg: "RS256", ext: true } };
  throw new Error(`不支持的通行密钥类型（${kty}/${alg}）`);
}

// WebAuthn 的 ECDSA 签名是 DER 编码，WebCrypto 需要 r||s
function derToRaw(der: Uint8Array): Uint8Array {
  let p = 2;
  if (der[1] & 0x80) p += der[1] & 0x7f;
  const read = () => {
    if (der[p] !== 0x02) throw new Error("签名格式错误");
    const len = der[p + 1];
    let v = der.slice(p + 2, p + 2 + len);
    p += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = read();
  const s = read();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

// 最小的 CBOR 解码（WebAuthn 只用到整数、字节串、文本、数组、映射）
function cborDecode(buf: Uint8Array): unknown {
  let p = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf[p++];
    if (info === 25) return (p += 2), view.getUint16(p - 2);
    if (info === 26) return (p += 4), view.getUint32(p - 4);
    if (info === 27) return (p += 8), Number(view.getBigUint64(p - 8));
    throw new Error("CBOR 不支持的长度");
  };
  const item = (): unknown => {
    const b = buf[p++];
    const major = b >> 5;
    const info = b & 0x1f;
    switch (major) {
      case 0:
        return len(info);
      case 1:
        return -1 - len(info);
      case 2: {
        const n = len(info);
        return buf.slice(p, (p += n));
      }
      case 3: {
        const n = len(info);
        return new TextDecoder().decode(buf.slice(p, (p += n)));
      }
      case 4: {
        const n = len(info);
        return Array.from({ length: n }, item);
      }
      case 5: {
        const n = len(info);
        const m = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) m.set(item(), item());
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error("CBOR 不支持的类型");
      default:
        throw new Error("CBOR 不支持的类型");
    }
  };
  return item();
}

export const newUserHandle = () => randomId(16);
