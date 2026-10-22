// 释放 Resend 名额：Resend 按账户里的域名数计算名额（免费版 3 个），只能删除域名来腾出名额
import { api } from "./api.js";
import { emit, store } from "./store.js";
import { confirmDialog, toast, toastError } from "./ui.js";
import { esc } from "./util.js";

export async function releaseResend(name, after) {
  const d = store.domains.find((x) => x.name === name);
  const primary = d?.send_provider === "resend";
  const backup = primary && d.fallback_provider && d.fallback_provider !== "resend" && d.fallback_status !== "error";
  const tail = !d
    ? ""
    : primary
      ? backup
        ? "之后这个域名改用 Cloudflare 发件。"
        : "之后这个域名只能收信、不能发信，直到重新开通发件服务。"
      : d.fallback_provider === "resend"
        ? "这个域名的备用发件会关闭。"
        : "";
  // 每句话单独一个元素，英文界面可以逐句翻译
  const message = ["将从 Resend 删除这个域名（释放 1 个名额），并删除本应用写入的 Resend DNS 记录。", tail, "以后可以随时重新开通，DNS 记录会自动重新写入。"]
    .filter(Boolean)
    .map((s) => `<span>${esc(s)}</span>`)
    .join("");
  if (!(await confirmDialog({ title: `停用 ${name} 的 Resend 发件？`, message, confirmLabel: "停用并释放", danger: true }))) return;
  const t = toast(`正在从 Resend 删除 ${name}…`, { type: "loading", duration: 0 });
  try {
    const r = await api(`/domains/${encodeURIComponent(name)}/resend/release`, { body: {} });
    t.close();
    toast(r.detail, { type: r.warning ? "info" : "success", duration: 7000 });
  } catch (e) {
    t.close();
    toastError(e);
  }
  emit("domains:refresh");
  after?.();
}
