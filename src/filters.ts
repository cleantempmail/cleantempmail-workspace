// 收信过滤：发件人验证结果、屏蔽名单、规则、可选的 AI 垃圾邮件判定
import type { Env } from "./env";
import { domainOf, getSetting, now } from "./util";

export interface AuthResult {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  score?: number; // Cloudflare 的 X-CF-SpamH-Score
  dkimDomain?: string;
}

// Cloudflare Email Routing 会在信头加上 "Authentication-Results: mx.cloudflare.net; dkim=pass ...; dmarc=...; spf=..."
export function parseAuth(headers: Headers): AuthResult {
  const out: AuthResult = {};
  const all = headers.get("authentication-results") ?? "";
  // Headers.get 会把多个同名头用 ", " 拼起来，取 Cloudflare 自己那一段
  const idx = all.indexOf("mx.cloudflare.net");
  const seg = idx >= 0 ? all.slice(idx) : all;
  const pick = (k: string) => seg.match(new RegExp(`\\b${k}=([a-z]+)`, "i"))?.[1]?.toLowerCase();
  out.spf = pick("spf");
  out.dkim = pick("dkim");
  out.dmarc = pick("dmarc");
  out.dkimDomain = seg.match(/header\.d=([^\s;]+)/i)?.[1]?.toLowerCase();
  const score = headers.get("x-cf-spamh-score");
  if (score !== null && score !== "" && !Number.isNaN(Number(score))) out.score = Number(score);
  return out;
}

export async function blocklistAction(env: Env, from: string): Promise<"spam" | "reject" | null> {
  const a = from.toLowerCase();
  const row = await env.DB.prepare("SELECT action FROM blocklist WHERE pattern IN (?, ?) ORDER BY action = 'reject' DESC LIMIT 1")
    .bind(a, "@" + domainOf(a))
    .first<{ action: "spam" | "reject" }>();
  return row?.action ?? null;
}

// ---------- 规则 ----------

export interface RuleCondition {
  field: "to" | "from" | "subject" | "body" | "has_attachment";
  op: "contains" | "equals" | "starts" | "ends" | "not_contains";
  value: string;
}
export interface RuleActions {
  labels?: string[];
  archive?: boolean;
  star?: boolean;
  read?: boolean;
  spam?: boolean;
  mute?: boolean;
  forward?: string; // 必须是 Cloudflare 中已验证的目标地址
}
export interface Rule {
  id: string;
  name: string;
  enabled: number;
  match_all: number;
  conditions: RuleCondition[];
  actions: RuleActions;
}

export interface RuleInput {
  to: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  hasAttachment: boolean;
}

function testCondition(c: RuleCondition, m: RuleInput): boolean {
  if (c.field === "has_attachment") return m.hasAttachment === (c.value !== "false");
  const hay = (c.field === "from" ? `${m.from} ${m.fromName}` : c.field === "to" ? m.to : c.field === "subject" ? m.subject : m.body).toLowerCase();
  const v = (c.value ?? "").toLowerCase().trim();
  if (!v) return false;
  switch (c.op) {
    case "equals":
      return c.field === "from" ? m.from.toLowerCase() === v : hay === v;
    case "starts":
      return hay.startsWith(v);
    case "ends":
      return (c.field === "from" ? m.from.toLowerCase() : hay).endsWith(v);
    case "not_contains":
      return !hay.includes(v);
    default:
      return hay.includes(v);
  }
}

export async function loadRules(env: Env): Promise<Rule[]> {
  const { results } = await env.DB.prepare("SELECT * FROM rules WHERE enabled = 1 ORDER BY sort, created_at").all<any>();
  return results.map((r) => ({ ...r, conditions: JSON.parse(r.conditions), actions: JSON.parse(r.actions) }));
}

export function applyRules(rules: Rule[], m: RuleInput): { actions: RuleActions; matched: string[] } {
  const acc: RuleActions = { labels: [] };
  const matched: string[] = [];
  for (const r of rules) {
    if (!r.conditions.length) continue;
    const ok = r.match_all ? r.conditions.every((c) => testCondition(c, m)) : r.conditions.some((c) => testCondition(c, m));
    if (!ok) continue;
    matched.push(r.id);
    const a = r.actions;
    if (a.labels?.length) acc.labels = [...new Set([...(acc.labels ?? []), ...a.labels])];
    for (const k of ["archive", "star", "read", "spam", "mute"] as const) if (a[k]) acc[k] = true;
    if (a.forward && !acc.forward) acc.forward = a.forward;
  }
  return { actions: acc, matched };
}

export async function bumpRuleHits(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await env.DB.batch(ids.map((id) => env.DB.prepare("UPDATE rules SET hits = hits + 1 WHERE id = ?").bind(id)));
}

// ---------- AI 垃圾邮件判定（可选，默认关闭） ----------

export const AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

export async function aiIsSpam(env: Env, m: { from: string; subject: string; text: string }): Promise<boolean> {
  if (!env.AI || (await getSetting(env, "pref_ai_spam")) !== "1") return false;
  try {
    const res: any = await env.AI.run(AI_MODEL as any, {
      messages: [
        {
          role: "system",
          content:
            "/no_think You are an email spam classifier. Reply with exactly one word: SPAM or HAM. Phishing, scams, unsolicited bulk advertising and malware are SPAM. Newsletters the user likely subscribed to, receipts, notifications and personal mail are HAM.",
        },
        { role: "user", content: `From: ${m.from}\nSubject: ${m.subject}\n\n${m.text.slice(0, 1500)}` },
      ],
      max_tokens: 6,
      chat_template_kwargs: { enable_thinking: false },
    } as any);
    const ch = res?.choices?.[0];
    const out = String(res?.response || ch?.message?.content || ch?.message?.reasoning_content || "").trim().toUpperCase();
    return out.startsWith("SPAM");
  } catch {
    return false;
  }
}

export async function spamThreshold(env: Env): Promise<number | null> {
  const v = await getSetting(env, "pref_spam_score");
  return v && !Number.isNaN(Number(v)) ? Number(v) : null;
}

export { now };
