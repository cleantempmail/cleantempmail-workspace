// 系统：导入邮件、系统状态（收信异常、当日用量、存储方式检查）、版本检查
import { Hono } from "hono";
import { ownerCf, requireAdmin } from "../auth";
import type { AppEnv, Env } from "../env";
import { ingest, parseHeaderBlock } from "../mail";
import { storageMode } from "../storage";
import { getSetting, isEmail, now, setSetting, workerName } from "../util";
import { REPO, VERSION } from "../version";

export const system = new Hono<AppEnv>();
system.use("/import", requireAdmin);
system.use("/system/*", requireAdmin);

// ---------- 导入（浏览器把 mbox 拆成单封后逐封上传，或者直接上传 .eml） ----------
// 发件人是自己域名的地址 → 放进"已发送"；否则放进收件地址（或指定的地址）的收件箱。按 Message-ID 去重，重复导入会跳过
const MAX_IMPORT = 25 * 1024 * 1024;

system.post("/import", async (c) => {
  const len = Number(c.req.header("Content-Length") ?? 0);
  if (len > MAX_IMPORT) return c.json({ error: "单封邮件不能超过 25 MB" }, 413);
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (!raw.length) return c.json({ error: "邮件是空的" }, 400);
  if (raw.length > MAX_IMPORT) return c.json({ error: "单封邮件不能超过 25 MB" }, 413);
  const target = (c.req.query("mailbox") ?? "").trim().toLowerCase();
  const markRead = c.req.query("read") !== "0";

  const headers = parseHeaderBlock(raw);
  const { results } = await c.env.DB.prepare("SELECT name FROM domains").all<{ name: string }>();
  const mine = new Set(results.map((r) => r.name));
  const own = (a: string) => mine.has(a.split("@")[1] ?? "");
  const addrs = (v: string | null) => [...(v ?? "").matchAll(/[^\s<>"',;:()]+@[^\s<>"',;:()]+\.[a-z0-9-]{2,}/gi)].map((m) => m[0].toLowerCase());
  const from = addrs(headers.get("from"))[0] ?? "";

  let folder: "inbox" | "sent" = "inbox";
  let rcpt = "";
  if (from && own(from)) {
    folder = "sent";
    rcpt = from;
  } else if (target) {
    if (!isEmail(target) || !own(target)) return c.json({ error: "导入到的地址必须属于已添加的域名" }, 400);
    rcpt = target;
  } else {
    rcpt = [...addrs(headers.get("delivered-to")), ...addrs(headers.get("to")), ...addrs(headers.get("cc")), ...addrs(headers.get("x-original-to"))].find(own) ?? "";
  }
  if (!rcpt) return c.json({ error: "这封邮件的收件人里没有你的域名，请选择要导入到哪个地址", code: "no_mailbox" }, 422);

  const r = await ingest(c.env, { raw, rcpt, envelopeFrom: from || "unknown@unknown.invalid", headers, rawSize: raw.length, source: "import", folder, markRead });
  return c.json({ ok: true, status: r.status, id: r.id ?? null, mailbox: rcpt, folder });
});

// ---------- 版本 ----------

const cmpVersion = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

// 最新版本：从 GitHub 读取 src/version.ts，结果缓存 12 小时
async function latestVersion(env: Env): Promise<string | null> {
  const cached = await getSetting(env, "update_check");
  try {
    const c = cached ? (JSON.parse(cached) as { v: string | null; at: number }) : null;
    if (c && now() - c.at < 12 * 3600) return c.v;
  } catch {}
  let v: string | null = null;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/src/version.ts`, { cf: { cacheTtl: 3600 } } as RequestInit);
    if (res.ok) v = (await res.text()).match(/VERSION\s*=\s*"([\d.]+)"/)?.[1] ?? null;
  } catch {}
  await setSetting(env, "update_check", JSON.stringify({ v, at: now() }));
  return v;
}

async function versionInfo(env: Env) {
  const latest = await latestVersion(env);
  return {
    version: VERSION,
    latest,
    updateAvailable: Boolean(latest && cmpVersion(latest, VERSION) > 0),
    changelog: `https://github.com/${REPO}/blob/main/CHANGELOG.md`,
  };
}

// ---------- 用量（Cloudflare GraphQL，需要令牌有「账户分析：读取」权限） ----------

export const FREE_LIMITS = { d1RowsRead: 5_000_000, d1RowsWritten: 100_000, workersRequests: 100_000 };

interface Usage {
  date: string;
  d1RowsRead: number;
  d1RowsWritten: number;
  workersRequests: number; // 整个账户
  scriptRequests: number; // 本 Worker
  scriptErrors: Record<string, number>; // 本 Worker 按状态（exceededResources = 超出 CPU / 内存限制）
}

async function fetchUsage(env: Env): Promise<Usage | { error: string }> {
  const accountId = await getSetting(env, "account_id");
  const owner = await ownerCf(env).catch(() => null);
  if (!accountId || !owner) return { error: "需要先在「账户与安全」里配置 Cloudflare API 令牌" };
  const date = new Date().toISOString().slice(0, 10);
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${owner.cf.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($acc: string!, $date: Date!) { viewer { accounts(filter: {accountTag: $acc}) {
        d1AnalyticsAdaptiveGroups(limit: 1000, filter: {date_geq: $date}) { sum { rowsRead rowsWritten } }
        workersInvocationsAdaptive(limit: 1000, filter: {date_geq: $date}) { sum { requests } dimensions { scriptName status } } } } }`,
      variables: { acc: accountId, date },
    }),
  }).catch(() => null);
  const data: any = await res?.json().catch(() => null);
  const acc = data?.data?.viewer?.accounts?.[0];
  if (!acc) {
    const msg = data?.errors?.[0]?.message ?? "";
    return { error: /auth|permission|access/i.test(msg) ? "令牌没有「账户分析：读取」权限，看不到用量" : `暂时无法获取用量${msg ? `：${msg}` : ""}` };
  }
  const name = await workerName(env);
  const usage: Usage = { date, d1RowsRead: 0, d1RowsWritten: 0, workersRequests: 0, scriptRequests: 0, scriptErrors: {} };
  for (const g of acc.d1AnalyticsAdaptiveGroups ?? []) {
    usage.d1RowsRead += g.sum?.rowsRead ?? 0;
    usage.d1RowsWritten += g.sum?.rowsWritten ?? 0;
  }
  for (const g of acc.workersInvocationsAdaptive ?? []) {
    const n = g.sum?.requests ?? 0;
    usage.workersRequests += n;
    if (g.dimensions?.scriptName !== name) continue;
    usage.scriptRequests += n;
    const st = g.dimensions?.status;
    if (st && st !== "success" && st !== "clientDisconnected") usage.scriptErrors[st] = (usage.scriptErrors[st] ?? 0) + n;
  }
  return usage;
}

// 用量缓存 30 分钟（GraphQL 查询较慢，也没必要每次打开都查）
async function cachedUsage(env: Env, fresh = false): Promise<Usage | { error: string }> {
  if (!fresh) {
    try {
      const c = JSON.parse((await getSetting(env, "usage_cache")) ?? "null");
      if (c && now() - c.at < 1800) return c.u;
    } catch {}
  }
  const u = await fetchUsage(env);
  await setSetting(env, "usage_cache", JSON.stringify({ u, at: now() }));
  return u;
}

async function storageCheck(env: Env) {
  const recorded = await getSetting(env, "storage_mode");
  const mode = storageMode(env);
  const hasMail = Boolean(await env.DB.prepare("SELECT 1 FROM messages LIMIT 1").first());
  return { mode, recorded, mismatch: Boolean(recorded && recorded !== mode && hasMail) };
}

system.get("/system/status", async (c) => {
  const since = now() - 86400;
  const [events, counts, pending, storage, version, usage] = await Promise.all([
    c.env.DB.prepare("SELECT id, kind, detail, created_at FROM events ORDER BY id DESC LIMIT 30").all<{ id: number; kind: string; detail: string; created_at: number }>(),
    c.env.DB.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE created_at > ? GROUP BY kind").bind(since).all<{ kind: string; n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE parse_error = 'pending'").first<{ n: number }>(),
    storageCheck(c.env),
    versionInfo(c.env),
    cachedUsage(c.env, c.req.query("fresh") === "1"),
  ]);
  return c.json({
    version,
    storage,
    pending: pending?.n ?? 0,
    events: events.results.map((e) => ({ ...e, detail: JSON.parse(e.detail || "{}") })),
    counts24h: Object.fromEntries(counts.results.map((r) => [r.kind, r.n])),
    usage,
    limits: FREE_LIMITS,
  });
});

// 打开应用时检查一次：最近 24 小时的收信异常、额度快用完、存储方式不一致、有新版本
system.get("/system/alerts", async (c) => {
  const since = now() - 86400;
  const [counts, storage, version, usage] = await Promise.all([
    c.env.DB.prepare("SELECT kind, COUNT(*) AS n, MAX(id) AS last FROM events WHERE created_at > ? GROUP BY kind").bind(since).all<{ kind: string; n: number; last: number }>(),
    storageCheck(c.env),
    versionInfo(c.env),
    cachedUsage(c.env),
  ]);
  const alerts: { key: string; level: "error" | "warn" | "info"; text: string }[] = [];
  const inbound = counts.results.filter((r) => r.kind === "inbound_error" || r.kind === "inbound_timeout");
  const nIn = inbound.reduce((a, b) => a + b.n, 0);
  if (nIn) alerts.push({ key: `inbound:${Math.max(...inbound.map((r) => r.last))}`, level: "error", text: `最近 24 小时有 ${nIn} 封邮件收信异常` });
  const sched = counts.results.find((r) => r.kind === "scheduled_failed");
  if (sched) alerts.push({ key: `scheduled:${sched.last}`, level: "warn", text: `最近 24 小时有 ${sched.n} 封定时邮件发送失败` });
  if (storage.mismatch) alerts.push({ key: "storage", level: "error", text: "存储方式和之前不一致，已有邮件的正文可能无法读取" });
  if (!("error" in usage)) {
    const pct = Math.max(usage.d1RowsRead / FREE_LIMITS.d1RowsRead, usage.d1RowsWritten / FREE_LIMITS.d1RowsWritten, usage.workersRequests / FREE_LIMITS.workersRequests);
    if (pct >= 0.8) alerts.push({ key: `usage:${usage.date}`, level: "warn", text: `今天的 Cloudflare 用量已达到免费额度的 ${Math.round(pct * 100)}%` });
    const cpu = usage.scriptErrors.exceededResources ?? 0;
    if (cpu) alerts.push({ key: `cpu:${usage.date}:${cpu}`, level: "warn", text: `今天有 ${cpu} 次请求超出了 CPU / 内存限制` });
  }
  if (version.updateAvailable) alerts.push({ key: `update:${version.latest}`, level: "info", text: `有新版本 ${version.latest}（当前 ${version.version}）` });
  return c.json({ alerts });
});

system.post("/system/events/clear", async (c) => {
  await c.env.DB.prepare("DELETE FROM events").run();
  return c.json({ ok: true });
});
