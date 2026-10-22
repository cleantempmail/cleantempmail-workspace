// 浏览器推送订阅
import { api } from "./api.js";
import { prefs } from "./util.js";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const pushSupported = supported;

function keyBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush() {
  if (!supported()) throw new Error("这个浏览器不支持推送通知");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("浏览器拒绝了通知权限");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { key } = await api("/push/key");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const json = sub.toJSON();
  await api("/push/subscribe", { body: { endpoint: json.endpoint, keys: json.keys } });
  prefs.set("notify", true);
}

export async function disablePush() {
  prefs.set("notify", false);
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api("/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}

// 已开启时，每次打开页面确认订阅仍然有效（浏览器可能轮换订阅）
export async function refreshPush() {
  if (!prefs.get("notify", false) || !supported() || Notification.permission !== "granted") return;
  try {
    await enablePush();
  } catch {}
}
