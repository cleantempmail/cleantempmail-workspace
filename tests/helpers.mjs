// 测试辅助：登录、调用接口、投递邮件、执行 SQL、触发定时任务
import { spawnSync } from "node:child_process";

export const BASE = process.env.TEST_BASE ?? "http://127.0.0.1:8790";
export const MOCK = process.env.TEST_MOCK;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

export class Client {
  constructor() {
    this.cookie = "";
  }
  async login() {
    const res = await fetch(`${BASE}/auth/login`, { redirect: "manual" });
    this.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    if (!this.cookie) throw new Error("开发模式登录失败");
    return this;
  }
  async req(path, { method, body, raw, headers = {} } = {}) {
    const res = await fetch(BASE + path, {
      method: method ?? (body !== undefined || raw !== undefined ? "POST" : "GET"),
      headers: { Cookie: this.cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      redirect: "manual",
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  }
  async api(path, opts) {
    const r = await this.req("/api" + path, opts);
    if (r.status >= 400) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
}

// 构造一封邮件（CRLF 换行）
let seq = 0;
export function mail({ from = "alice@sender.test", fromName = "Alice", to, subject = "测试", text = "hello", html, messageId, inReplyTo, references, headers = {}, attachments = [], date } = {}) {
  messageId ??= `<t${Date.now()}.${++seq}@sender.test>`;
  const b64 = (s) => Buffer.from(s).toString("base64");
  const head = [
    `From: =?UTF-8?B?${b64(fromName)}?= <${from}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: ${messageId}`,
    `Date: ${date ?? new Date().toUTCString()}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "MIME-Version: 1.0",
  ];
  let body;
  if (html) body = [...head, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(html)];
  else if (!attachments.length) body = [...head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(text)];
  else {
    const bd = "b" + seq;
    body = [...head, `Content-Type: multipart/mixed; boundary="${bd}"`, "", `--${bd}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(text)];
    for (const a of attachments) {
      body.push(`--${bd}`, `Content-Type: ${a.type ?? "application/octet-stream"}; name="${a.name}"`, `Content-Disposition: attachment; filename="${a.name}"`, "Content-Transfer-Encoding: base64", "", Buffer.from(a.data).toString("base64"));
    }
    body.push(`--${bd}--`);
  }
  return { raw: body.join("\r\n") + "\r\n", messageId };
}

// 通过本地 Email Routing 模拟投递
export async function deliver(m, to, from = "alice@sender.test") {
  const res = await fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: "POST", body: m.raw });
  if (!res.ok) throw new Error(`投递失败：${res.status} ${await res.text()}`);
}

export async function cron(expr = "* * * * *") {
  const res = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(expr)}`);
  if (!res.ok) throw new Error(`定时任务失败：${res.status}`);
  await new Promise((r) => setTimeout(r, 300));
}

// 直接对本地数据库执行 SQL（准备数据、检查结果）
export function sql(query) {
  const r = spawnSync(npx, ["wrangler", "d1", "execute", "DB", "--local", "--json", "-c", process.env.TEST_CONFIG, "--persist-to", process.env.TEST_PERSIST, "--command", query], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`SQL 失败：${query}\n${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout);
  return out[out.length - 1].results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
