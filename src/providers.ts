// 发件服务：Cloudflare Email Sending（需要 Workers Paid）或 Resend（免费额度可用）
import type { Env } from "./env";
import { decrypt, getSetting } from "./util";

export type Provider = "cloudflare" | "resend" | "none";

export interface Outgoing {
  from: { email: string; name?: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  headers: Record<string, string>;
  attachments: { filename: string; type: string; content: string }[]; // content 为 base64
  idempotencyKey?: string; // 同一草稿重复提交时防止重复发送（Resend 支持）
}

// RFC 5322：显示名里有逗号、分号、引号等特殊字符时必须加引号
export function formatAddress(name: string | undefined, email: string): string {
  if (!name) return email;
  const clean = name.replace(/[\r\n]/g, " ").trim();
  if (/^[\w\u00c0-\uffff .'-]+$/.test(clean) && !/[,;:<>@"()\[\]\\]/.test(clean)) return `${clean} <${email}>`;
  return `"${clean.replace(/(["\\])/g, "\\$1")}" <${email}>`;
}

export class SendError extends Error {
  // failover：服务端明确没有发出、且换一个发件服务有望成功（额度、验证、服务异常等）。
  // 超时、网络中断这类"不确定是否已发出"的情况不切换，避免对方收到两封。
  constructor(message: string, public code?: string, public failover = false) {
    super(message);
  }
}

// Cloudflare Email Sending：与发件服务本身有关、与邮件内容无关的错误
const CF_FAILOVER = new Set([
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_ACCOUNT_SUSPENDED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_CONTENT_TOO_LARGE",
  "E_INTERNAL_SERVER_ERROR",
]);
// Resend：额度、密钥、域名未验证。500 可能已经收下，不切换
const RESEND_FAILOVER = new Set([
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "missing_api_key",
  "invalid_api_key",
  "invalid_api_Key",
  "restricted_api_key",
]);
const UNCERTAIN = /time(d)?\s?out|network|abort|reset|socket|connection/i;

export async function resendKey(env: Env): Promise<string | null> {
  const enc = await getSetting(env, "resend_api_key");
  return enc ? decrypt(env, enc) : null;
}

export async function sendVia(env: Env, provider: Provider, m: Outgoing): Promise<string | null> {
  if (provider === "cloudflare") {
    try {
      const res = await env.EMAIL.send({
        from: m.from.name ? { email: m.from.email, name: m.from.name } : m.from.email,
        to: m.to,
        ...(m.cc.length ? { cc: m.cc } : {}),
        ...(m.bcc.length ? { bcc: m.bcc } : {}),
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(Object.keys(m.headers).length ? { headers: m.headers } : {}),
        ...(m.attachments.length
          ? { attachments: m.attachments.map((a) => ({ ...a, disposition: "attachment" as const })) }
          : {}),
      });
      return res.messageId ?? null;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const code: string | undefined = e?.code ?? msg.match(/\bE_[A-Z_]+\b/)?.[0];
      // 没有错误码的通常是绑定/开通层面的问题（例如账户未开通 Workers Paid）
      const failover = code ? CF_FAILOVER.has(code) : !UNCERTAIN.test(msg);
      throw new SendError(`Cloudflare 发送失败：${msg}`, code, failover);
    }
  }

  if (provider === "resend") {
    const key = await resendKey(env);
    if (!key) throw new SendError("尚未配置 Resend API Key", "missing_api_key", true);
    const res = await fetch(`${env.RESEND_API_BASE ?? "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify({
        from: formatAddress(m.from.name, m.from.email),
        to: m.to,
        cc: m.cc.length ? m.cc : undefined,
        bcc: m.bcc.length ? m.bcc : undefined,
        subject: m.subject,
        text: m.text,
        html: m.html,
        headers: m.headers,
        attachments: m.attachments.length
          ? m.attachments.map((a) => ({ filename: a.filename, content: a.content, content_type: a.type }))
          : undefined,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const failover = res.status === 429 || RESEND_FAILOVER.has(data.name) || (res.status === 403 && /domain/i.test(data.message ?? ""));
      throw new SendError(`Resend 发送失败：${data.message ?? res.status}`, data.name, failover);
    }
    return data.id ?? null;
  }

  throw new SendError("这个域名还没有可用的发件服务，请在「域名」页配置");
}

// ---- Resend 域名接入 ----

interface ResendRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  ttl?: string;
  status?: string;
}

interface ResendDomain {
  id: string;
  name: string;
  status: string; // not_started | pending | verified | failed | temporary_failure
  records?: ResendRecord[];
}

export async function resendApi<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const key = await resendKey(env);
  if (!key) throw new Error("尚未配置 Resend API Key");
  const res = await fetch((env.RESEND_API_BASE ?? "https://api.resend.com") + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend：${data.message ?? res.status}`);
  return data as T;
}

export async function resendDomains(env: Env): Promise<ResendDomain[]> {
  return (await resendApi<{ data: ResendDomain[] }>(env, "GET", "/domains")).data ?? [];
}

// Resend 按账户里的域名数计算名额（不论是否验证通过），免费版最多 3 个
export const RESEND_FREE_DOMAINS = 3;

export async function resendFindOrCreateDomain(env: Env, domain: string): Promise<ResendDomain> {
  const list = await resendDomains(env);
  const existing = list.find((d) => d.name === domain);
  if (existing) return resendApi<ResendDomain>(env, "GET", `/domains/${existing.id}`);
  try {
    return await resendApi<ResendDomain>(env, "POST", "/domains", { name: domain });
  } catch (e: any) {
    const msg = String(e.message);
    const limitLike = /limit|maxim|plan|upgrade|exceed/i.test(msg);
    if (!limitLike && list.length < RESEND_FREE_DOMAINS) throw e;
    throw new Error(
      `${limitLike ? "Resend 域名名额已满" : msg}。Resend 里现有 ${list.length} 个域名：${list.map((d) => d.name).join("、")}。` +
        `免费版最多 ${RESEND_FREE_DOMAINS} 个，可以在不常用的域名菜单里选「停用 Resend 发件」释放名额，或升级 Resend 套餐` +
        (limitLike ? `（${msg}）` : ""),
    );
  }
}

export function resendRecordFqdn(domain: string, name: string): string {
  if (!name || name === "@") return domain;
  return name === domain || name.endsWith("." + domain) ? name : `${name}.${domain}`;
}

export type { ResendDomain, ResendRecord };
