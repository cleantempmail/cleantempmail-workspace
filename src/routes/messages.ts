// 邮件读取与整理：会话列表（走汇总表）、会话详情、整理操作、正文与附件、统计
import { Hono, type Context } from "hono";
import type { AppEnv, Env, Session } from "../env";
import { cidPattern, isInlineShown, purgeMessages, type StoredBody } from "../mail";
import { isEmail } from "../util";
import { sendVia, type Provider } from "../providers";
import { messageInScope, messageScopeSql, threadScopeSql } from "../scope";
import { protectHtml } from "../privacy";
import { parseSearch } from "../search";
import { backfillPending, backfillStep, refreshThreads, touch } from "../threads";
import { chunk, domainOf, getSetting, now, placeholders, randomId } from "../util";
import { blobs, getMany } from "../storage";

export const messages = new Hono<AppEnv>();

const PAGE = 40;
const live = "deleted_at IS NULL";

// ---------- 会话列表 ----------

messages.get("/threads", async (c) => {
  const s = c.get("session");
  const { view = "inbox", arg, q, filter, before } = c.req.query();
  const t = now();
  const where: string[] = [];
  const args: unknown[] = [];
  let sortCol = "t.sort_at";

  switch (view) {
    case "inbox":
      where.push("t.n_inbox > 0 AND (t.snooze_until IS NULL OR t.snooze_until <= ?)");
      args.push(t);
      break;
    case "snoozed":
      where.push("t.snooze_until > ?");
      args.push(t);
      sortCol = "t.snooze_until";
      break;
    case "starred":
      where.push("t.starred = 1");
      break;
    case "sent":
      where.push("t.n_sent > 0");
      break;
    case "archive":
      where.push("t.n_archive > 0 AND t.n_inbox = 0");
      break;
    case "spam":
      where.push("t.n_spam > 0");
      break;
    case "trash":
      where.push("t.n_trash > 0");
      sortCol = "t.trash_at";
      break;
    // 单个地址 / 域名：只看这一页需要的最近若干封邮件（走 (mailbox|domain, deleted_at, created_at) 索引），不扫整个地址
    case "box":
    case "domain": {
      const col = view === "box" ? "mailbox" : "domain";
      const bt = before ? Number(before.split(":")[0]) : 0;
      where.push(
        `t.thread_id IN (SELECT thread_id FROM messages WHERE ${col} = ? AND ${live} AND spam = 0${bt ? " AND created_at <= ?" : ""} ORDER BY created_at DESC LIMIT 2000)`,
      );
      args.push((arg ?? "").toLowerCase(), ...(bt ? [bt] : []));
      break;
    }
    case "label":
      where.push("t.n_live > 0 AND t.thread_id IN (SELECT thread_id FROM thread_labels WHERE label_id = ?)");
      args.push(arg ?? "");
      break;
    default: // all
      where.push("t.n_live > t.n_spam");
  }

  if (q?.trim()) {
    const ps = parseSearch(q);
    const mw: string[] = [...ps.where];
    const ma: unknown[] = [...ps.args];
    mw.push(ps.scope === "trash" ? "deleted_at IS NOT NULL" : ps.scope === "spam" ? `${live} AND spam = 1` : ps.scope === "all" ? "1=1" : `${live} AND spam = 0`);
    if (ps.folder) (mw.push("folder = ?"), ma.push(ps.folder));
    // 常见词可能匹配几万封：只取最近匹配的 500 封
    if (ps.fts) (mw.push("rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT 500)"), ma.push(ps.fts));
    const ms = messageScopeSql(s.scope);
    mw.push(ms.sql);
    ma.push(...ms.args);
    // 搜索是全局的；在某个地址/域名/标签里搜索时限定在该范围
    const keep = ["box", "domain", "label"].includes(view);
    if (!keep) {
      where.length = 0;
      args.length = 0;
      sortCol = ps.scope === "trash" ? "t.trash_at" : "t.sort_at";
      where.push(ps.scope === "trash" ? "t.n_trash > 0" : "1=1");
    }
    where.push(`t.thread_id IN (SELECT DISTINCT thread_id FROM messages WHERE ${mw.join(" AND ")})`);
    args.push(...ma);
  }
  if (filter === "unread") where.push("t.unread > 0");
  if (filter === "starred") where.push("t.starred = 1");
  if (filter === "attachments") where.push("t.has_att = 1");
  const ts = threadScopeSql(s.scope);
  where.push(ts.sql);
  args.push(...ts.args);
  if (before) {
    // 先用 <= 走索引范围，再排除同一时间点已经显示过的
    const [bt, bid] = before.split(":");
    where.push(`${sortCol} <= ? AND (${sortCol} < ? OR t.thread_id < ?)`);
    args.push(Number(bt), Number(bt), bid ?? "");
  }

  // 标签用子查询一起取回：整个列表只有一次数据库往返
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, ${sortCol} AS sort_key,
       (SELECT json_group_array(label_id) FROM thread_labels tl WHERE tl.thread_id = t.thread_id) AS label_ids
     FROM threads t WHERE ${where.join(" AND ")} ORDER BY ${sortCol} DESC, t.thread_id DESC LIMIT ${PAGE + 1}`,
  ).bind(...args).all<any>();
  const hasMore = results.length > PAGE;
  const rows = results.slice(0, PAGE);
  if (!s.scope.all) await scopeSummaries(c.env, s, rows);
  const threads = rows.map((r) => ({
    thread_id: r.thread_id,
    id: r.last_id,
    folder: r.last_folder,
    mailbox: r.last_mailbox,
    from_addr: r.last_from_addr,
    from_name: r.last_from_name,
    to_addrs: r.last_to_addrs,
    subject: r.subject,
    snippet: r.snippet,
    created_at: view === "trash" ? r.trash_at : r.sort_at,
    cnt: r.cnt,
    unread: r.unread,
    any_att: r.has_att,
    any_star: r.starred,
    spam: r.n_spam > 0,
    participants: JSON.parse(r.participants || "[]"),
    labels: JSON.parse(r.label_ids || "[]"),
    snooze_until: r.snooze_until,
    delivery: r.delivery,
    verified: Boolean(r.last_verified),
  }));
  const last = rows[rows.length - 1];
  return c.json({ threads, next: hasMore && last ? `${last.sort_key}:${last.thread_id}` : null });
});

// 团队成员：会话摘要（最新一封、未读数、参与人）只按权限范围内的邮件计算，不显示范围以外的邮件内容
async function scopeSummaries(env: Env, s: Session, rows: any[]): Promise<void> {
  if (!rows.length) return;
  const ms = messageScopeSql(s.scope);
  const { results } = await env.DB.prepare(
    `SELECT id, thread_id, folder, mailbox, from_addr, from_name, to_addrs, subject, snippet, created_at, is_read, spam, auth, is_bounce
     FROM messages WHERE thread_id IN (${placeholders(rows.length)}) AND ${ms.sql} ORDER BY created_at, rowid`,
  ).bind(...rows.map((r) => r.thread_id), ...ms.args).all<any>();
  const by = new Map<string, any[]>();
  for (const m of results) (by.get(m.thread_id) ?? by.set(m.thread_id, []).get(m.thread_id)!).push(m);
  for (const r of rows) {
    const msgs = by.get(r.thread_id) ?? [];
    const last = msgs[msgs.length - 1];
    if (!last) continue;
    const title = msgs.find((m) => !m.is_bounce && m.subject) ?? msgs[0];
    const people: { name: string; address: string; me: boolean }[] = [];
    for (const m of msgs) {
      const p = m.folder === "sent" ? { name: "我", address: m.from_addr, me: true } : { name: m.from_name || m.from_addr.split("@")[0], address: m.from_addr, me: false };
      if (!people.some((x) => x.address === p.address)) people.push(p);
    }
    Object.assign(r, {
      last_id: last.id, last_folder: last.folder, last_mailbox: last.mailbox, last_from_addr: last.from_addr, last_from_name: last.from_name,
      last_to_addrs: last.to_addrs, subject: title.subject, snippet: last.snippet, cnt: msgs.length, participants: JSON.stringify(people),
      unread: msgs.filter((m) => m.folder === "inbox" && !m.is_read && !m.spam).length,
      last_verified: last.folder === "inbox" && safeJson(last.auth)?.dmarc === "pass" ? 1 : 0,
    });
  }
}

async function loadBody(env: Env, id: string): Promise<StoredBody> {
  const obj = await blobs(env).get(`msg/${id}/body.json`);
  return obj ? obj.json<StoredBody>() : { text: "", html: null, attachments: [] };
}

const safeJson = (s: string | null) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

// ---------- 会话详情 ----------

messages.get("/threads/:tid", async (c) => {
  const s = c.get("session");
  const tid = c.req.param("tid");
  const trash = c.req.query("trash") === "1";
  const ms = messageScopeSql(s.scope);
  // 取最新的 100 封再按时间正序显示，保证"回复"针对的是最后一封
  const [msgRes, labelRes, threadRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS ${trash ? "NOT NULL" : "NULL"} AND ${ms.sql}
       ORDER BY created_at DESC, rowid DESC LIMIT 100`,
    ).bind(tid, ...ms.args),
    c.env.DB.prepare("SELECT label_id FROM thread_labels WHERE thread_id = ?").bind(tid),
    c.env.DB.prepare("SELECT snooze_until FROM threads WHERE thread_id = ?").bind(tid),
  ]);
  const desc = msgRes.results as any[];
  if (!desc.length) {
    // 列表里有、打开却没有邮件：会话汇总过期了（例如删除时 D1 临时出错），顺手修好，刷新后就不再显示
    c.executionCtx.waitUntil(refreshThreads(c.env, [tid]).catch(() => {}));
    return c.json({ error: "会话不存在或已删除" }, 404);
  }
  const results = desc.reverse();
  // 标为已读和读取正文同时进行（少等一次数据库往返）；peek=1 是悬停预取，不标已读
  const unreadIds = results.filter((m) => m.folder === "inbox" && !m.is_read).map((m) => m.id);
  const markRead =
    unreadIds.length && c.req.query("peek") !== "1"
      ? c.env.DB.prepare(`UPDATE messages SET is_read = 1 WHERE id IN (${placeholders(unreadIds.length)})`).bind(...unreadIds).run()
      : null;
  // 正文一次批量读取（免绑卡模式下逐封读取，长会话会超过每次 50 次 D1 查询的上限）
  const objs = await getMany(c.env, results.map((m) => `msg/${m.id}/body.json`));
  const withBodies = await Promise.all(
    results.map(async (m) => {
      const obj = objs.get(`msg/${m.id}/body.json`);
      const body: StoredBody = obj
        ? await obj.json<StoredBody>()
        : { text: m.parse_error === "pending" ? "（这封邮件正在处理中，请稍后刷新。）" : m.snippet ?? "", html: null, attachments: [] };
      return {
        ...m,
        text: body.text,
        hasHtml: Boolean(body.html),
        auth: safeJson(m.auth),
        list_unsub: safeJson(m.list_unsub),
        attachments: body.attachments.map((a, index) => ({
          index,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          inline: isInlineShown(a, body.html),
          missing: a.missing || undefined,
        })),
      };
    }),
  );
  const labels = labelRes as D1Result<{ label_id: string }>;
  const thread = (threadRes.results[0] ?? null) as { snooze_until: number | null } | null;
  if (markRead) {
    await markRead;
    c.executionCtx.waitUntil(touch(c.env, { threads: [tid] }));
  }
  return c.json({ threadId: tid, messages: withBodies, labels: labels.results.map((l) => l.label_id), snooze_until: thread?.snooze_until ?? null });
});

// 回复/转发时引用原文
messages.get("/messages/:id/body", async (c) => {
  const id = c.req.param("id");
  if (!(await messageInScope(c.env, c.get("session"), id))) return c.json({ error: "邮件不存在" }, 404);
  const b = await loadBody(c.env, id);
  return c.json({ html: b.html, text: b.text });
});

// ---------- 整理操作 ----------

type Action =
  | "read" | "unread" | "star" | "unstar" | "archive" | "unarchive" | "trash" | "restore" | "delete" | "purge_spam"
  | "spam" | "notspam" | "snooze" | "unsnooze" | "label" | "unlabel";

async function visibleThreads(env: Env, s: Session, ids: string[]): Promise<string[]> {
  if (s.scope.all) return ids;
  const ts = threadScopeSql(s.scope);
  const out: string[] = [];
  for (const part of chunk(ids, 40)) {
    const { results } = await env.DB.prepare(`SELECT thread_id FROM threads t WHERE thread_id IN (${placeholders(part.length)}) AND ${ts.sql}`)
      .bind(...part, ...ts.args)
      .all<{ thread_id: string }>();
    out.push(...results.map((r) => r.thread_id));
  }
  return out;
}

async function threadAction(env: Env, s: Session, threadIds: string[], action: Action, opts: { until?: number; labelId?: string; blockSender?: boolean }) {
  const ids = await visibleThreads(env, s, [...new Set(threadIds)]);
  if (!ids.length) return;
  const ms = messageScopeSql(s.scope);
  const t = now();
  const parts = chunk(ids, Math.max(10, 90 - ms.args.length - 2));
  for (const part of parts) {
    const ph = placeholders(part.length);
    const inT = `thread_id IN (${ph})`;
    const run = (sql: string, ...pre: unknown[]) => env.DB.prepare(sql).bind(...pre, ...part, ...ms.args);
    const latestInbox = `id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) rn
        FROM messages WHERE folder = 'inbox' AND ${live} AND ${inT} AND ${ms.sql}) WHERE rn = 1)`;
    const stmts: D1PreparedStatement[] = [];
    switch (action) {
      case "read":
        stmts.push(run(`UPDATE messages SET is_read = 1 WHERE folder = 'inbox' AND ${inT} AND ${ms.sql}`));
        break;
      case "unread":
        stmts.push(run(`UPDATE messages SET is_read = 0 WHERE ${latestInbox}`));
        break;
      case "star":
        stmts.push(run(`UPDATE messages SET starred = 1 WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) rn
          FROM messages WHERE ${live} AND ${inT} AND ${ms.sql}) WHERE rn = 1)`));
        break;
      case "unstar":
        stmts.push(run(`UPDATE messages SET starred = 0 WHERE ${inT} AND ${ms.sql}`));
        break;
      case "archive":
        stmts.push(run(`UPDATE messages SET archived = 1, is_read = 1 WHERE folder = 'inbox' AND ${inT} AND ${ms.sql}`));
        break;
      case "unarchive":
        stmts.push(run(`UPDATE messages SET archived = 0 WHERE folder = 'inbox' AND ${inT} AND ${ms.sql}`));
        break;
      case "trash":
        stmts.push(run(`UPDATE messages SET deleted_at = ? WHERE ${live} AND ${inT} AND ${ms.sql}`, t));
        break;
      case "restore":
        stmts.push(run(`UPDATE messages SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND ${inT} AND ${ms.sql}`));
        break;
      case "spam":
        if (opts.blockSender) {
          stmts.push(run(`INSERT OR IGNORE INTO blocklist (pattern, action, created_at)
            SELECT DISTINCT lower(from_addr), 'spam', ? FROM messages WHERE folder = 'inbox' AND ${inT} AND ${ms.sql}`, t));
        }
        stmts.push(run(`UPDATE messages SET spam = 1, is_read = 1 WHERE folder = 'inbox' AND ${inT} AND ${ms.sql}`));
        break;
      case "notspam":
        stmts.push(run(`DELETE FROM blocklist WHERE pattern IN (SELECT lower(from_addr) FROM messages WHERE folder = 'inbox' AND spam = 1 AND ${inT} AND ${ms.sql})`));
        stmts.push(run(`UPDATE messages SET spam = 0 WHERE ${inT} AND ${ms.sql}`));
        break;
      case "snooze":
        stmts.push(env.DB.prepare(`UPDATE threads SET snooze_until = ? WHERE ${inT}`).bind(opts.until ?? t + 3600, ...part));
        break;
      case "unsnooze":
        stmts.push(env.DB.prepare(`UPDATE threads SET snooze_until = NULL, unsnoozed_at = ?, sort_at = MAX(sort_at, ?) WHERE ${inT}`).bind(t, t, ...part));
        break;
      case "label":
      case "unlabel":
        if (!opts.labelId) break;
        for (const tid of part) {
          stmts.push(
            action === "label"
              ? env.DB.prepare("INSERT OR IGNORE INTO thread_labels (thread_id, label_id) VALUES (?, ?)").bind(tid, opts.labelId)
              : env.DB.prepare("DELETE FROM thread_labels WHERE thread_id = ? AND label_id = ?").bind(tid, opts.labelId),
          );
        }
        break;
      case "delete":
      case "purge_spam": {
        // 垃圾邮件视图里的"永久删除"只删被判为垃圾的邮件，同一会话里的正常往来和已发送不受影响
        const cond = action === "delete" ? "deleted_at IS NOT NULL" : `${live} AND spam = 1`;
        const { results } = await env.DB.prepare(`SELECT id FROM messages WHERE ${cond} AND ${inT} AND ${ms.sql}`)
          .bind(...part, ...ms.args)
          .all<{ id: string }>();
        await purgeMessages(env, results.map((r) => r.id));
        continue;
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  if (!["label", "unlabel", "snooze", "delete", "purge_spam"].includes(action)) await touch(env, { threads: ids });
}

messages.post("/threads/action", async (c) => {
  const body = await c.req.json<{ threadIds: string[]; action: Action; until?: number; labelId?: string; blockSender?: boolean }>();
  await threadAction(c.env, c.get("session"), (body.threadIds ?? []).slice(0, 1000), body.action, body);
  return c.json({ ok: true });
});

messages.post("/messages/:id/action", async (c) => {
  const id = c.req.param("id");
  const s = c.get("session");
  if (!(await messageInScope(c.env, s, id))) return c.json({ error: "邮件不存在" }, 404);
  const { action } = await c.req.json<{ action: Action }>();
  const sql: Partial<Record<Action, string>> = {
    read: "UPDATE messages SET is_read = 1 WHERE id = ?",
    unread: "UPDATE messages SET is_read = 0 WHERE id = ?",
    star: "UPDATE messages SET starred = 1 WHERE id = ?",
    unstar: "UPDATE messages SET starred = 0 WHERE id = ?",
    trash: `UPDATE messages SET deleted_at = ${now()} WHERE id = ?`,
    restore: "UPDATE messages SET deleted_at = NULL WHERE id = ?",
    spam: "UPDATE messages SET spam = 1, is_read = 1 WHERE id = ? AND folder = 'inbox'",
    notspam: "UPDATE messages SET spam = 0 WHERE id = ?",
  };
  if (action === "delete") {
    await purgeMessages(c.env, [id]);
    return c.json({ ok: true });
  }
  if (!sql[action]) return c.json({ error: "未知操作" }, 400);
  await c.env.DB.prepare(sql[action]!).bind(id).run();
  await touch(c.env, { messageIds: [id] });
  return c.json({ ok: true });
});

// 清空废纸篓 / 垃圾邮件：每次最多处理 200 封，前端循环调用直到 remaining = 0
messages.post("/trash/empty", async (c) => {
  const s = c.get("session");
  const { which = "trash" } = await c.req.json<{ which?: "trash" | "spam" }>().catch(() => ({ which: "trash" as const }));
  const ms = messageScopeSql(s.scope);
  const cond = which === "spam" ? `${live} AND spam = 1` : "deleted_at IS NOT NULL";
  const { results } = await c.env.DB.prepare(`SELECT id FROM messages WHERE ${cond} AND ${ms.sql} LIMIT 200`).bind(...ms.args).all<{ id: string }>();
  await purgeMessages(c.env, results.map((r) => r.id));
  const left = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${cond} AND ${ms.sql}`).bind(...ms.args).first<{ n: number }>();
  return c.json({ ok: true, deleted: results.length, remaining: left?.n ?? 0 });
});

// ---------- 正文与附件 ----------

const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf)$/i;

async function guard(c: Context<AppEnv>, id: string) {
  return messageInScope(c.env, c.get("session"), id);
}

messages.get("/messages/:id/attachments/:n", async (c) => {
  const id = c.req.param("id");
  if (!(await guard(c, id))) return c.json({ error: "附件不存在" }, 404);
  const body = await loadBody(c.env, id);
  const att = body.attachments[Number(c.req.param("n"))];
  if (att?.missing) return c.json({ error: "这个附件收信时没能保存，请在「更多」菜单中下载原始邮件查看" }, 410);
  const obj = att && (await blobs(c.env).get(att.key));
  if (!obj) return c.json({ error: "附件不存在" }, 404);
  const inline = c.req.query("inline") === "1" && SAFE_INLINE.test(att.mimeType);
  const isPdf = /pdf$/i.test(att.mimeType);
  return new Response(obj.body, {
    headers: {
      // 只有图片和 PDF 允许在浏览器里打开，其他一律下载，防止邮件附件在本站执行脚本
      "Content-Type": inline ? att.mimeType : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      "X-Content-Type-Options": "nosniff",
      ...(isPdf ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'" }),
      "Cache-Control": "private, max-age=86400",
    },
  });
});

messages.get("/messages/:id/raw", async (c) => {
  const id = c.req.param("id");
  if (!(await guard(c, id))) return c.json({ error: "邮件不存在" }, 404);
  const obj = await blobs(c.env).get(`msg/${id}/raw.eml`);
  if (!obj) return c.json({ error: "没有原始邮件（发件箱中的邮件不保存原文）" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "message/rfc822", "Content-Disposition": `attachment; filename="${id}.eml"`, "X-Content-Type-Options": "nosniff" },
  });
});

const BASE_STYLE = `
  html,body{margin:0;padding:0;background:#fff}
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:#1f2329;word-break:break-word;overflow-wrap:anywhere;padding:2px}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  pre{white-space:pre-wrap}
  a{color:#1a5fd6}
  blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d8dde6;color:#5b6474}
  .cfm-hide-quotes .gmail_quote,.cfm-hide-quotes blockquote[type=cite],.cfm-hide-quotes .cfm-quote,
  .cfm-hide-quotes #divRplyFwdMsg,.cfm-hide-quotes #divRplyFwdMsg ~ *,.cfm-hide-quotes .yahoo_quoted{display:none!important}
`;

// 在沙箱 iframe 中显示的 HTML 正文：服务端设置严格 CSP，任何情况下都不直接请求发件人的服务器（防追踪）
// images=1 时远程图片改写为经本服务的隐私代理加载；否则保留原地址，由 CSP 阻止
messages.get("/messages/:id/html", async (c) => {
  const id = c.req.param("id");
  if (!(await guard(c, id))) return c.json({ error: "邮件不存在" }, 404);
  const body = await loadBody(c.env, id);
  const images = c.req.query("images") === "1";
  let html = body.html ?? `<pre>${(body.text ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!)}</pre>`;
  body.attachments.forEach((a, n) => {
    if (a.contentId) html = html.replace(cidPattern(a.contentId), `/api/messages/${id}/attachments/${n}?inline=1`);
  });
  // 同源图片只允许隐私代理和邮件自己的内嵌附件：邮件里写 <img src="/auth/..."> 之类的站内地址不会被加载
  const origin = new URL(c.req.url).origin;
  const csp = [
    "default-src 'none'",
    `img-src data: ${origin}/api/img ${origin}/api/messages/${id}/attachments/`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const marker = `cfm-${randomId(8)}`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<base target="_blank"><style>${BASE_STYLE}</style></head><body ${marker}>${html}</body></html>`;
  const { html: safe, report } = await protectHtml(c.env, doc, images);
  // 拦截统计写在 body 上，阅读页据此显示"已拦截 N 个追踪器"
  const out = safe.replace(marker, `data-cfm-trackers="${report.trackers}" data-cfm-links="${report.links}" data-cfm-remote="${report.remote}"`);
  return c.html(out, 200, {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-DNS-Prefetch-Control": "off",
    // 同一封邮件的正文不会变：浏览器缓存一小时，悬停预取和再次打开都不用重新请求
    "Cache-Control": "private, max-age=3600",
  });
});

// ---------- 一键退订（RFC 8058） ----------

function safePublicUrl(u: string): URL | null {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

// List-Unsubscribe 的 mailto 由发件人填写：只允许单个合法地址，主题和正文限制长度、去掉换行
// （阅读页的确认框会显示实际收件地址）
export function parseUnsubMailto(v: string | undefined | null): { to: string; subject: string; body: string } | null {
  if (!v) return null;
  const [addr, query] = v.split("?");
  let to: string;
  try {
    to = decodeURIComponent(addr).trim().toLowerCase();
  } catch {
    return null;
  }
  if (!isEmail(to) || /[,;]/.test(to)) return null;
  const params = new URLSearchParams(query ?? "");
  const clean = (x: string | null, max: number) => (x ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
  return { to, subject: clean(params.get("subject"), 200) || "unsubscribe", body: clean(params.get("body"), 500) || "unsubscribe" };
}

messages.post("/messages/:id/unsubscribe", async (c) => {
  const id = c.req.param("id");
  if (!(await guard(c, id))) return c.json({ error: "邮件不存在" }, 404);
  const row = await c.env.DB.prepare("SELECT mailbox, list_unsub FROM messages WHERE id = ?").bind(id).first<{ mailbox: string; list_unsub: string | null }>();
  const u = safeJson(row?.list_unsub ?? null) as { url?: string; mailto?: string; oneClick?: boolean } | null;
  if (!row || !u) return c.json({ error: "这封邮件没有退订信息" }, 400);
  if (u.oneClick && u.url) {
    const url = safePublicUrl(u.url);
    if (url) {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", redirect: "manual" }).catch(() => null);
      if (res && res.status < 400) return c.json({ ok: true, method: "one-click" });
    }
  }
  const mailto = parseUnsubMailto(u.mailto);
  if (mailto) {
    const d = await c.env.DB.prepare("SELECT send_provider FROM domains WHERE name = ?").bind(domainOf(row.mailbox)).first<{ send_provider: Provider }>();
    if (d && d.send_provider !== "none") {
      await sendVia(c.env, d.send_provider, {
        from: { email: row.mailbox },
        to: [mailto.to],
        cc: [],
        bcc: [],
        subject: mailto.subject,
        text: mailto.body,
        headers: {},
        attachments: [],
      });
      return c.json({ ok: true, method: "mailto", to: mailto.to });
    }
  }
  if (u.url && safePublicUrl(u.url)) return c.json({ ok: true, method: "open", url: u.url });
  return c.json({ error: "无法自动退订，请在邮件正文中找退订链接" }, 400);
});

// ---------- 统计与轮询 ----------

messages.get("/stats", async (c) => {
  const s = c.get("session");
  const ms = messageScopeSql(s.scope);
  const ts = threadScopeSql(s.scope);
  const t = now();
  // 侧栏所需的全部计数：一次 batch，一次往返
  // 稍后提醒数走 idx_threads_snooze；垃圾邮件数直接用地址计数表汇总（之前要扫整张 threads 表）
  const [boxes, drafts, counts, labels, prefs] = await c.env.DB.batch<any>([
    c.env.DB.prepare(`SELECT mailbox, domain, total, unread, spam, last_at FROM mailbox_stats WHERE total > 0 AND ${ms.sql} ORDER BY domain, mailbox`).bind(...ms.args),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE owner = ?").bind(s.userId),
    c.env.DB.prepare(`SELECT COUNT(*) AS snoozed FROM threads t WHERE snooze_until IS NOT NULL AND snooze_until > ? AND ${ts.sql}`).bind(t, ...ts.args),
    c.env.DB.prepare(`SELECT tl.label_id, SUM(t.unread) AS unread, COUNT(*) AS n FROM thread_labels tl JOIN threads t ON t.thread_id = tl.thread_id
      WHERE t.n_live > 0 AND ${ts.sql} GROUP BY tl.label_id`).bind(...ts.args),
    c.env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('pref_remote_images', 'backfill_v3')"),
  ]);
  const unread = boxes.results.reduce((a: number, b: any) => a + (b.unread || 0), 0);
  const latestInboxAt = boxes.results.reduce((a: number, b: any) => Math.max(a, b.last_at || 0), 0);
  const pref = Object.fromEntries(prefs.results.map((r: any) => [r.key, r.value]));
  if (pref.backfill_v3 !== "done") c.executionCtx.waitUntil(backfillStep(c.env).catch(() => {}));
  return c.json({
    unread,
    mailboxes: boxes.results,
    drafts: drafts.results[0]?.n ?? 0,
    snoozed: counts.results[0]?.snoozed ?? 0,
    spam: boxes.results.reduce((a: number, b: any) => a + (b.spam || 0), 0),
    labels: labels.results,
    latestInboxAt,
    remoteImages: pref.pref_remote_images ?? "always",
  });
});

// 轻量轮询：只读计数表
messages.get("/poll", async (c) => {
  const s = c.get("session");
  const ms = messageScopeSql(s.scope);
  // 管理员只读一行合计（由触发器维护），成员按权限范围汇总地址计数
  const row = s.scope.all
    ? await c.env.DB.prepare("SELECT unread, last_at AS latest FROM stats_total WHERE id = 1").first<{ unread: number; latest: number }>()
    : await c.env.DB.prepare(`SELECT COALESCE(SUM(unread), 0) AS unread, COALESCE(MAX(last_at), 0) AS latest FROM mailbox_stats WHERE ${ms.sql}`)
        .bind(...ms.args)
        .first<{ unread: number; latest: number }>();
  let recent: unknown[] = [];
  if (c.req.query("recent") === "1") {
    const since = Number(c.req.query("since") ?? 0);
    const r = await c.env.DB.prepare(
      `SELECT from_name, from_addr, subject, mailbox, thread_id FROM messages
       WHERE folder = 'inbox' AND ${live} AND spam = 0 AND created_at > ? AND ${ms.sql} ORDER BY created_at DESC LIMIT 3`,
    ).bind(since, ...ms.args).all();
    recent = r.results;
  }
  return c.json({ unread: row?.unread ?? 0, latestInboxAt: row?.latest ?? 0, recent });
});
