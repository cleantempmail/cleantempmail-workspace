// 工作台功能：地址管理、屏蔽名单、规则、标签、团队成员、推送、AI、导出、存储、投递状态
import { Hono } from "hono";
import { cfClient, requireAdmin, sendSystemMail, sessionTokenScope, workerAccountId } from "../auth";
import type { Cf } from "../cf";
import type { AppEnv, Env } from "../env";
import { AI_MODEL } from "../filters";
import type { StoredBody } from "../mail";
import { vapidPublicKey } from "../push";
import { canUseAddress, messageScopeSql, parseScope } from "../scope";
import { touch } from "../threads";
import { chunk, domainOf, isEmail, now, placeholders, randomId, sha256hex } from "../util";
import { blobs, liteUsage, storageMode } from "../storage";

export const org = new Hono<AppEnv>();

// ---------- 地址管理 ----------

org.get("/addresses", async (c) => {
  const s = c.get("session");
  const ms = messageScopeSql(s.scope, "a").sql.replace(/a\.mailbox/g, "a.address");
  const args = messageScopeSql(s.scope).args;
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, COALESCE(st.total, 0) AS total, COALESCE(st.unread, 0) AS unread, COALESCE(st.spam, 0) AS spam_count
     FROM addresses a LEFT JOIN mailbox_stats st ON st.mailbox = a.address WHERE ${ms} ORDER BY a.domain, a.last_at DESC`,
  ).bind(...args).all();
  return c.json(results);
});

org.patch("/addresses/:address", async (c) => {
  const s = c.get("session");
  const addr = decodeURIComponent(c.req.param("address")).toLowerCase();
  if (!canUseAddress(s.scope, addr)) return c.json({ error: "无权修改" }, 403);
  const body = await c.req.json<{ note?: string | null; color?: string | null; muted?: boolean; blocked?: boolean }>();
  if (body.blocked !== undefined && s.role !== "admin") return c.json({ error: "只有管理员可以停用地址" }, 403);
  const sets: string[] = [];
  const args: unknown[] = [];
  if ("note" in body) (sets.push("note = ?"), args.push(body.note?.slice(0, 200) || null));
  if ("color" in body) (sets.push("color = ?"), args.push(body.color && /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : null));
  if (body.muted !== undefined) (sets.push("muted = ?"), args.push(body.muted ? 1 : 0));
  if (body.blocked !== undefined) (sets.push("blocked = ?"), args.push(body.blocked ? 1 : 0));
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(
    `INSERT INTO addresses (address, domain, first_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO NOTHING`,
  ).bind(addr, domainOf(addr), now(), now()).run();
  await c.env.DB.prepare(`UPDATE addresses SET ${sets.join(", ")} WHERE address = ?`).bind(...args, addr).run();
  return c.json({ ok: true });
});

// ---------- 屏蔽名单 ----------

org.get("/blocklist", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM blocklist ORDER BY created_at DESC").all();
  return c.json(results);
});

org.post("/blocklist", requireAdmin, async (c) => {
  const { pattern, action = "spam" } = await c.req.json<{ pattern: string; action?: "spam" | "reject" }>();
  const p = (pattern ?? "").trim().toLowerCase();
  if (!(isEmail(p) || /^@[^\s@]+\.[^\s@]+$/.test(p))) return c.json({ error: "请填写完整地址或 @域名" }, 400);
  await c.env.DB.prepare("INSERT INTO blocklist (pattern, action, created_at) VALUES (?, ?, ?) ON CONFLICT(pattern) DO UPDATE SET action = excluded.action")
    .bind(p, action === "reject" ? "reject" : "spam", now())
    .run();
  return c.json({ ok: true });
});

org.delete("/blocklist/:pattern", requireAdmin, async (c) => {
  await c.env.DB.prepare("DELETE FROM blocklist WHERE pattern = ?").bind(decodeURIComponent(c.req.param("pattern")!)).run();
  return c.json({ ok: true });
});

// ---------- 规则 ----------

org.get("/rules", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM rules ORDER BY sort, created_at").all<any>();
  return c.json(results.map((r) => ({ ...r, conditions: JSON.parse(r.conditions), actions: JSON.parse(r.actions) })));
});

org.put("/rules/:id", requireAdmin, async (c) => {
  const r = await c.req.json<{ name: string; enabled?: boolean; match_all?: boolean; conditions: unknown[]; actions: Record<string, unknown>; sort?: number }>();
  if (!r.name?.trim()) return c.json({ error: "请填写规则名称" }, 400);
  if (!Array.isArray(r.conditions) || !r.conditions.length) return c.json({ error: "至少需要一个条件" }, 400);
  if (typeof r.actions?.forward === "string" && r.actions.forward && !isEmail(r.actions.forward)) return c.json({ error: "转发地址无效" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO rules (id, name, enabled, match_all, conditions, actions, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, match_all = excluded.match_all,
       conditions = excluded.conditions, actions = excluded.actions, sort = excluded.sort`,
  ).bind(c.req.param("id"), r.name.trim(), r.enabled === false ? 0 : 1, r.match_all === false ? 0 : 1, JSON.stringify(r.conditions), JSON.stringify(r.actions ?? {}), r.sort ?? 0, now()).run();
  return c.json({ ok: true });
});

org.delete("/rules/:id", requireAdmin, async (c) => {
  await c.env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---------- 标签 ----------

org.get("/labels", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM labels ORDER BY sort, name").all();
  return c.json(results);
});

org.put("/labels/:id", async (c) => {
  const { name, color, sort } = await c.req.json<{ name: string; color: string; sort?: number }>();
  if (!name?.trim()) return c.json({ error: "请填写标签名称" }, 400);
  await c.env.DB.prepare("INSERT INTO labels (id, name, color, sort) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, sort = excluded.sort")
    .bind(c.req.param("id"), name.trim().slice(0, 40), /^#[0-9a-f]{6}$/i.test(color) ? color : "#6b7280", sort ?? 0)
    .run();
  return c.json({ ok: true });
});

org.delete("/labels/:id", requireAdmin, async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM thread_labels WHERE label_id = ?").bind(c.req.param("id")),
    c.env.DB.prepare("DELETE FROM labels WHERE id = ?").bind(c.req.param("id")),
  ]);
  return c.json({ ok: true });
});

// ---------- 团队成员 ----------

org.get("/members", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, email, name, scope, disabled, created_at, last_login_at FROM members ORDER BY created_at").all<any>();
  return c.json(results.map((m) => ({ ...m, scope: parseScope(m.scope) })));
});

org.put("/members/:id", requireAdmin, async (c) => {
  const m = await c.req.json<{ email: string; name?: string; scope: { all?: boolean; domains?: string[]; addresses?: string[] }; disabled?: boolean }>();
  const email = (m.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) return c.json({ error: "邮箱地址无效" }, 400);
  const scope = parseScope(JSON.stringify(m.scope ?? {}));
  if (!scope.all && !scope.domains.length && !scope.addresses.length) return c.json({ error: "请至少授权一个域名或地址" }, 400);
  try {
    await c.env.DB.prepare(
      `INSERT INTO members (id, email, name, scope, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, scope = excluded.scope, disabled = excluded.disabled`,
    ).bind(c.req.param("id"), email, m.name?.trim() || null, JSON.stringify(scope), m.disabled ? 1 : 0, now()).run();
  } catch {
    return c.json({ error: "这个邮箱已经是成员了" }, 409);
  }
  if (m.disabled) await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind("member:" + c.req.param("id")).run();
  return c.json({ ok: true });
});

org.delete("/members/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind("member:" + id),
    c.env.DB.prepare("DELETE FROM push_subs WHERE user_id = ?").bind("member:" + id),
    c.env.DB.prepare("DELETE FROM login_tokens WHERE member_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

// 给成员发送登录邀请
org.post("/members/:id/invite", requireAdmin, async (c) => {
  const m = await c.env.DB.prepare("SELECT id, email, name FROM members WHERE id = ? AND disabled = 0").bind(c.req.param("id")).first<{ id: string; email: string; name: string | null }>();
  if (!m) return c.json({ error: "成员不存在或已停用" }, 404);
  const token = randomId(32);
  await c.env.DB.prepare("INSERT INTO login_tokens (hash, member_id, expires_at) VALUES (?, ?, ?)").bind(await sha256hex(token), m.id, now() + 7 * 86400).run();
  const link = new URL(`/auth/magic/${token}`, c.req.url).toString();
  await sendSystemMail(
    c.env,
    m.email,
    "你被邀请加入 CleanTempMail Workspace",
    `你好${m.name ? " " + m.name : ""}：\n\n你已被添加为 CleanTempMail Workspace 的成员。点击下面的链接登录（7 天内有效，只能使用一次）：\n${link}\n\n之后可以在登录页输入这个邮箱，随时获取新的登录链接：\n${new URL("/", c.req.url).toString()}`,
  );
  return c.json({ ok: true });
});

// ---------- 推送订阅 ----------

org.get("/push/key", async (c) => c.json({ key: await vapidPublicKey(c.env) }));

org.post("/push/subscribe", async (c) => {
  const { endpoint, keys } = await c.req.json<{ endpoint: string; keys?: unknown }>();
  if (!/^https:\/\//.test(endpoint ?? "")) return c.json({ error: "无效的订阅" }, 400);
  await c.env.DB.prepare("INSERT INTO push_subs (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id")
    .bind(endpoint, c.get("session").userId, JSON.stringify(keys ?? null), now())
    .run();
  return c.json({ ok: true });
});

org.post("/push/unsubscribe", async (c) => {
  const { endpoint } = await c.req.json<{ endpoint: string }>();
  await c.env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?").bind(endpoint, c.get("session").userId).run();
  return c.json({ ok: true });
});

// ---------- AI 助手（Workers AI，数据不出 Cloudflare） ----------

async function aiText(env: Env, system: string, user: string, maxTokens = 800): Promise<string> {
  if (!env.AI) throw new Error("没有配置 Workers AI 绑定");
  let res: any;
  try {
    res = await runAi(env, system, user, maxTokens);
  } catch (e: any) {
    console.error("workers ai", e?.message);
    const code = String(e?.message ?? "").match(/\d{4}/)?.[0];
    throw new Error(`AI 服务暂时不可用，请稍后再试${code ? `（错误 ${code}）` : ""}`);
  }
  const choice = res?.choices?.[0];
  // 关闭思考后，部分模型会把正文放在 reasoning 字段里；只有正常结束（stop）时才采用，避免把半截思考过程当成答案
  const out = res?.response || choice?.message?.content || (choice?.finish_reason === "stop" ? choice?.message?.reasoning_content || choice?.message?.reasoning : "") || "";
  return String(out).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function runAi(env: Env, system: string, user: string, maxTokens: number): Promise<any> {
  return env.AI!.run(AI_MODEL as any, {
    messages: [
      { role: "system", content: system + " /no_think" },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens + 1200,
    // 关闭推理过程（GLM / Qwen 等推理模型会先"思考"，占用输出额度）
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: "low",
  } as any);
}

async function bodyText(env: Env, id: string): Promise<string> {
  const obj = await blobs(env).get(`msg/${id}/body.json`);
  return obj ? ((await obj.json<StoredBody>()).text ?? "") : "";
}

org.post("/ai/summarize", async (c) => {
  const s = c.get("session");
  const { threadId } = await c.req.json<{ threadId: string }>();
  const ms = messageScopeSql(s.scope);
  const { results } = await c.env.DB.prepare(
    `SELECT id, from_name, from_addr, folder, subject, created_at FROM messages WHERE thread_id = ? AND deleted_at IS NULL AND ${ms.sql} ORDER BY created_at DESC LIMIT 12`,
  ).bind(threadId, ...ms.args).all<any>();
  if (!results.length) return c.json({ error: "会话不存在" }, 404);
  let corpus = "";
  for (const m of results.reverse()) {
    const t = (await bodyText(c.env, m.id)).replace(/\n>.*$/gm, "").slice(0, 2500);
    corpus += `\n---\n发件人：${m.folder === "sent" ? "我" : m.from_name || m.from_addr}\n时间：${new Date(m.created_at * 1000).toISOString().slice(0, 16)}\n${t}`;
  }
  const summary = await aiText(
    c.env,
    "你是邮件助理。用简体中文总结下面的邮件会话：先用一句话说明主题，然后用 3-6 个要点列出关键信息、结论和需要我处理的待办（如果有）。不要编造内容。",
    `主题：${results[results.length - 1].subject}\n${corpus.slice(-12000)}`,
  );
  return c.json({ summary });
});

org.post("/ai/translate", async (c) => {
  const { messageId, lang = "zh" } = await c.req.json<{ messageId: string; lang?: string }>();
  const s = c.get("session");
  const ms = messageScopeSql(s.scope);
  if (!(await c.env.DB.prepare(`SELECT 1 FROM messages WHERE id = ? AND ${ms.sql}`).bind(messageId, ...ms.args).first())) return c.json({ error: "邮件不存在" }, 404);
  const target = { zh: "简体中文", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" }[lang] ?? lang;
  const text = (await bodyText(c.env, messageId)).slice(0, 8000);
  const translation = await aiText(c.env, `把用户给的邮件正文翻译成${target}。保留段落和列表格式，只输出译文。`, text, 2000);
  return c.json({ translation });
});

org.post("/ai/reply", async (c) => {
  const { messageId, instruction } = await c.req.json<{ messageId: string; instruction?: string }>();
  const s = c.get("session");
  const ms = messageScopeSql(s.scope);
  const m = await c.env.DB.prepare(`SELECT from_name, from_addr, subject FROM messages WHERE id = ? AND ${ms.sql}`).bind(messageId, ...ms.args).first<any>();
  if (!m) return c.json({ error: "邮件不存在" }, 404);
  const text = (await bodyText(c.env, messageId)).slice(0, 6000);
  const draft = await aiText(
    c.env,
    "你是我的邮件助理。我收到了一封邮件，请以我（收件人）的身份，给来信人写一封回复。使用与来信相同的语言；语气礼貌、简洁、专业。只输出回复正文：不要主题行、不要签名、不要解释、不要复述我的要求。",
    `【来信人】${m.from_name || m.from_addr}\n【主题】${m.subject}\n【来信内容】\n${text}\n\n【我想在回复中表达】${instruction?.trim() || "根据来信内容给出得体的回复"}`,
  );
  return c.json({ draft });
});

// ---------- 导出（mbox，每份最多 300 封，避免超出子请求限制） ----------

const EXPORT_PAGE = 300;

org.get("/export", async (c) => {
  const s = c.get("session");
  const { domain, mailbox } = c.req.query();
  const ms = messageScopeSql(s.scope);
  const where = [ms.sql];
  const args: unknown[] = [...ms.args];
  if (domain) (where.push("domain = ?"), args.push(domain));
  if (mailbox) (where.push("mailbox = ?"), args.push(mailbox));
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM messages WHERE ${where.join(" AND ")}`).bind(...args).first<{ n: number; bytes: number }>();
  return c.json({ total: row?.n ?? 0, bytes: row?.bytes ?? 0, pageSize: EXPORT_PAGE, pages: Math.ceil((row?.n ?? 0) / EXPORT_PAGE) });
});

function mboxEscape(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/^(>*From )/gm, ">$1");
}

org.get("/export.mbox", async (c) => {
  const s = c.get("session");
  const { domain, mailbox } = c.req.query();
  const page = Math.max(0, Number(c.req.query("page") ?? 0));
  const ms = messageScopeSql(s.scope);
  const where = [ms.sql];
  const args: unknown[] = [...ms.args];
  if (domain) (where.push("domain = ?"), args.push(domain));
  if (mailbox) (where.push("mailbox = ?"), args.push(mailbox));
  const { results } = await c.env.DB.prepare(
    `SELECT id, folder, from_addr, from_name, to_addrs, cc_addrs, subject, message_id, in_reply_to, created_at
     FROM messages WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ? OFFSET ?`,
  ).bind(...args, EXPORT_PAGE, page * EXPORT_PAGE).all<any>();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  c.executionCtx.waitUntil(
    (async () => {
      for (const m of results) {
        const date = new Date(m.created_at * 1000);
        let raw: string;
        const obj = m.folder === "inbox" ? await blobs(c.env).get(`msg/${m.id}/raw.eml`) : null;
        if (obj) raw = await obj.text();
        else {
          // 发出的邮件没有原文：用保存的内容重建一份纯文本邮件
          const addrs = (j: string | null) => (JSON.parse(j || "[]") as { address: string }[]).map((a) => a.address).join(", ");
          const enc64 = (str: string) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(str)))}?=`;
          raw = [
            `From: ${m.from_name ? enc64(m.from_name) + " " : ""}<${m.from_addr}>`,
            `To: ${addrs(m.to_addrs)}`,
            ...(addrs(m.cc_addrs) ? [`Cc: ${addrs(m.cc_addrs)}`] : []),
            `Subject: ${enc64(m.subject ?? "")}`,
            `Date: ${date.toUTCString()}`,
            ...(m.message_id ? [`Message-ID: ${m.message_id}`] : []),
            ...(m.in_reply_to ? [`In-Reply-To: ${m.in_reply_to}`] : []),
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: 8bit",
            "",
            await bodyText(c.env, m.id),
          ].join("\n");
        }
        await w.write(enc.encode(`From ${m.from_addr} ${date.toUTCString()}\n${mboxEscape(raw)}\n\n`));
      }
      await w.close();
    })().catch((e) => w.abort(e)),
  );
  const name = `cleantempmail-${domain || mailbox || "all"}-${page + 1}.mbox`.replace(/[^\w.@-]/g, "_");
  return new Response(readable, { headers: { "Content-Type": "application/mbox", "Content-Disposition": `attachment; filename="${name}"` } });
});

org.get("/storage", async (c) => {
  const s = c.get("session");
  const ms = messageScopeSql(s.scope);
  const { results } = await c.env.DB.prepare(
    `SELECT domain, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash,
       SUM(spam) AS spam FROM messages WHERE ${ms.sql} GROUP BY domain ORDER BY bytes DESC`,
  ).bind(...ms.args).all();
  const mode = storageMode(c.env);
  // 免绑卡模式：显示 D1 / KV 的用量与免费额度（只给管理员看）
  const lite = mode === "lite" && s.role === "admin" ? await liteUsage(c.env) : undefined;
  return c.json({ mode, domains: results, lite });
});

// ---------- 投递状态（GraphQL emailSendingAdaptive，需要 OAuth 勾选 analytics.read） ----------

export async function refreshDelivery(env: Env, cf: Cf, ids?: string[]): Promise<{ updated: number }> {
  const where = ["folder = 'sent'", "provider = 'cloudflare'", "provider_id IS NOT NULL", "delivery_status = 'sent'", "created_at > ?"];
  const args: unknown[] = [now() - 7 * 86400];
  if (ids?.length) (where.push(`id IN (${placeholders(ids.length)})`), args.push(...ids));
  const { results } = await env.DB.prepare(`SELECT m.id, m.provider_id, m.created_at, d.zone_id FROM messages m JOIN domains d ON d.name = m.domain WHERE ${where.join(" AND ")} LIMIT 200`)
    .bind(...args)
    .all<{ id: string; provider_id: string; created_at: number; zone_id: string }>();
  const byZone = new Map<string, typeof results>();
  for (const r of results) byZone.set(r.zone_id, [...(byZone.get(r.zone_id) ?? []), r]);
  let updated = 0;
  const changed: string[] = [];
  for (const [zone, rows] of byZone) {
    for (const part of chunk(rows, 50)) {
      const variants = part.flatMap((r) => [r.provider_id, r.provider_id.replace(/^<|>$/g, ""), `<${r.provider_id.replace(/^<|>$/g, "")}>`]);
      const since = new Date((Math.min(...part.map((r) => r.created_at)) - 300) * 1000).toISOString();
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${cf.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query($zoneTag: string!, $ids: [string!], $since: Time!) { viewer { zones(filter: {zoneTag: $zoneTag}) {
            emailSendingAdaptive(filter: {messageId_in: $ids, datetime_geq: $since}, limit: 500, orderBy: [datetime_ASC]) { messageId status errorCause errorDetail datetime } } } }`,
          variables: { zoneTag: zone, ids: [...new Set(variants)], since },
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      const events: any[] = data?.data?.viewer?.zones?.[0]?.emailSendingAdaptive ?? [];
      if (data?.errors?.length && !events.length) throw new Error(data.errors[0].message);
      for (const r of part) {
        const key = r.provider_id.replace(/^<|>$/g, "");
        const evs = events.filter((e) => String(e.messageId).replace(/^<|>$/g, "") === key);
        if (!evs.length) continue;
        const last = evs[evs.length - 1];
        const status = ({ delivered: "delivered", deliveryFailed: "bounced", rejected: "rejected", failed: "failed" } as Record<string, string>)[last.status];
        if (!status) continue;
        await env.DB.prepare("UPDATE messages SET delivery_status = ?, delivery_detail = ? WHERE id = ?")
          .bind(status, [last.errorCause, last.errorDetail].filter(Boolean).join(" · ") || null, r.id)
          .run();
        changed.push(r.id);
        updated++;
      }
    }
  }
  if (changed.length) await touch(env, { messageIds: changed });
  return { updated };
}

org.post("/delivery/refresh", requireAdmin, async (c) => {
  const scope = await sessionTokenScope(c);
  if (scope !== null && !scope.split(/\s+/).includes("analytics.read")) return c.json({ needsScope: true, updated: 0 });
  const { ids } = await c.req.json<{ ids?: string[] }>().catch(() => ({ ids: undefined }));
  try {
    return c.json(await refreshDelivery(c.env, await cfClient(c), ids?.slice(0, 80)));
  } catch (e: any) {
    if (/not authorized|permission|access/i.test(e.message)) return c.json({ needsScope: true, updated: 0 });
    throw e;
  }
});

// ---------- 抑制列表（Cloudflare 自动屏蔽的收件人） ----------

org.get("/suppressions", requireAdmin, async (c) => {
  const cf = await cfClient(c);
  const acc = await workerAccountId(c.env, cf);
  const list = await cf.get<any[]>(`/accounts/${acc}/email/sending/suppressions?per_page=200`).catch((e) => {
    throw new Error(`读取抑制列表失败：${e.message}`);
  });
  return c.json(list);
});

org.delete("/suppressions/:id", requireAdmin, async (c) => {
  const cf = await cfClient(c);
  const acc = await workerAccountId(c.env, cf);
  await cf.del(`/accounts/${acc}/email/sending/suppressions/${encodeURIComponent(c.req.param("id")!)}`);
  return c.json({ ok: true });
});

// ---------- 发件人品牌头像：由 Worker 代取并缓存，浏览器不直接访问第三方（不暴露你的 IP） ----------

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com",
  "qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "sina.com", "sina.cn", "sohu.com", "aliyun.com", "139.com", "189.cn",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "mail.com", "yandex.com", "yandex.ru", "aol.com", "zoho.com", "naver.com", "daum.net",
]);

org.get("/avatar/:domain", async (c) => {
  const domain = c.req.param("domain")!.toLowerCase().replace(/^.*@/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || FREEMAIL.has(domain)) return c.body(null, 404);
  // 子域名（mail.xxx.com、notify.xxx.com）归到主域名
  const parts = domain.split(".");
  // example.com → example.com；mail.example.com → example.com；mail.example.co.uk → example.co.uk
  const keep = parts.length > 2 && /^(com|net|org|co|gov|edu|ac)$/.test(parts[parts.length - 2]) ? 3 : 2;
  const base = parts.slice(-keep).join(".");
  const key = `avatars/${base}`;
  const headers = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, max-age=604800" };
  const cached = await blobs(c.env).get(key);
  if (cached) {
    if (cached.customMetadata?.missing === "1" && Number(cached.customMetadata.at ?? 0) > now() - 7 * 86400) return c.body(null, 404);
    if (cached.customMetadata?.missing !== "1") return new Response(cached.body, { headers: { ...headers, "Content-Type": cached.httpMetadata?.contentType ?? "image/png" } });
  }
  let img: ArrayBuffer | null = null;
  let type = "image/png";
  try {
    const res = await fetch(`https://icons.duckduckgo.com/ip3/${base}.ico`, { cf: { cacheTtl: 86400 } } as RequestInit);
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && /^image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp)/.test(ct)) {
      const buf = await res.arrayBuffer();
      // DuckDuckGo 对没有图标的域名返回一个很小的默认图，太小的当作没有
      if (buf.byteLength > 200 && buf.byteLength < 200_000) {
        img = buf;
        type = ct.includes("icon") ? "image/x-icon" : ct.split(";")[0];
      }
    }
  } catch {}
  if (!img) {
    await blobs(c.env).put(key, new Uint8Array(0), { customMetadata: { missing: "1", at: String(now()) } });
    return c.body(null, 404);
  }
  await blobs(c.env).put(key, img, { httpMetadata: { contentType: type } });
  return new Response(img, { headers: { ...headers, "Content-Type": type } });
});
