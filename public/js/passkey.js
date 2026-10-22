// 通行密钥（WebAuthn）：浏览器端注册与登录
import { api, authApi } from "./api.js";

export const passkeySupported = () => Boolean(window.PublicKeyCredential && navigator.credentials?.create);

const toB64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// 浏览器取消或超时时给出好懂的提示
function friendly(e) {
  if (e?.name === "NotAllowedError") return new Error("已取消，或者设备没有完成验证");
  if (e?.name === "InvalidStateError") return new Error("这台设备上已经有这个账户的通行密钥了");
  if (e?.name === "SecurityError") return new Error("当前网址不能使用通行密钥（需要 HTTPS）");
  return e;
}

export async function addPasskey(name) {
  const o = await api("/account/passkeys/begin", { body: {} });
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: fromB64url(o.challenge),
        rp: o.rp,
        user: { id: new TextEncoder().encode(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        excludeCredentials: o.excludeCredentials.map((id) => ({ type: "public-key", id: fromB64url(id) })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        attestation: "none",
        timeout: 120000,
      },
    });
  } catch (e) {
    throw friendly(e);
  }
  await api("/account/passkeys", {
    body: {
      id: toB64url(cred.rawId),
      clientDataJSON: toB64url(cred.response.clientDataJSON),
      attestationObject: toB64url(cred.response.attestationObject),
      name,
    },
  });
}

export async function loginWithPasskey() {
  const o = await authApi("/passkey/begin");
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: fromB64url(o.challenge),
        rpId: o.rpId,
        allowCredentials: o.allowCredentials.map((id) => ({ type: "public-key", id: fromB64url(id) })),
        userVerification: "preferred",
        timeout: 120000,
      },
    });
  } catch (e) {
    throw friendly(e);
  }
  await authApi("/passkey/finish", {
    id: toB64url(cred.rawId),
    clientDataJSON: toB64url(cred.response.clientDataJSON),
    authenticatorData: toB64url(cred.response.authenticatorData),
    signature: toB64url(cred.response.signature),
  });
}
