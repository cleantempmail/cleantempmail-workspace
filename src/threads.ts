// 会话汇总表与地址计数的维护：任何改动邮件的操作之后调用 touch()
import type { Env } from "./env";
import { indexMessage, peopleText } from "./search";
import { chunk, getSetting, now, placeholders, setSetting } from "./util";
import { blobs } from "./storage";

interface MsgMeta {
  id: string;
  thread_id: string;
  folder: string;
  mailbox: string;
  domain: string;
  from_addr: string;
  from_name: string | null;
  to_addrs: string;
  subject: string | null;
  snippet: string | null;
  created_at: number;
  is_read: number;
  has_attachments: number;
  starred: number;
  archived: number;
  spam: number;
  deleted_at: number | null;
  delivery_status: string | null;
  is_bounce: number;
}

const META_COLS =
  "id, thread_id, folder, mailbox, domain, from_addr, from_name, to_addrs, subject, snippet, created_at, is_read, has_attachments, starred, archived, spam, deleted_at, delivery_status, is_bounce";

export async function refreshThreads(env: Env, threadIds: string[]): Promise<void> {
  const ids = [...new Set(threadIds.filter(Boolean))];
  for (const part of chunk(ids, 80)) {
    const { results } = await env.DB.prepare(
      `SELECT ${META_COLS} FROM messages WHERE thread_id IN (${placeholders(part.length)}) ORDER BY created_at, id`,
    ).bind(...part).all<MsgMeta>();
    const byThread = new Map<string, MsgMeta[]>();
    for (const m of results) {
      const list = byThread.get(m.thread_id) ?? [];
      list.push(m);
      byThread.set(m.thread_id, list);
    }
    const stmts: D1PreparedStatement[] = [];
    const gone = part.filter((t) => !byThread.has(t));
    if (gone.length) {
      stmts.push(env.DB.prepare(`DELETE FROM threads WHERE thread_id IN (${placeholders(gone.length)})`).bind(...gone));
      stmts.push(env.DB.prepare(`DELETE FROM thread_labels WHERE thread_id IN (${placeholders(gone.length)})`).bind(...gone));
    }
    for (const [tid, msgs] of byThread) stmts.push(upsertThread(env, tid, msgs));
    if (stmts.length) await env.DB.batch(stmts);
  }
}

function upsertThread(env: Env, tid: string, msgs: MsgMeta[]): D1PreparedStatement {
  const live = msgs.filter((m) => m.deleted_at === null);
  const trash = msgs.filter((m) => m.deleted_at !== null);
  const scope = live.length ? live : trash; // 全部在垃圾箱时，用垃圾箱里的邮件做展示
  const last = scope[scope.length - 1];
  // 会话标题用最早那封（不是退信通知）的主题，和 Gmail 一致；摘要用最新一封
  const titleMsg = scope.find((m) => !m.is_bounce && m.subject) ?? scope[0];
  const people: { name: string; address: string; me: boolean }[] = [];
  for (const m of scope) {
    const p = m.folder === "sent" ? { name: "我", address: m.from_addr, me: true } : { name: m.from_name || m.from_addr.split("@")[0], address: m.from_addr, me: false };
    if (!people.some((x) => x.address === p.address)) people.push(p);
  }
  const boxes = [...new Set(msgs.map((m) => m.mailbox))];
  const domains = [...new Set(msgs.map((m) => m.domain))];
  const lastSent = [...live].reverse().find((m) => m.folder === "sent");
  const lastAt = last.created_at;
  return env.DB.prepare(
    `INSERT INTO threads (thread_id, sort_at, last_at, last_id, last_folder, last_mailbox, last_from_addr, last_from_name, last_to_addrs,
       subject, snippet, participants, mailboxes, domains, cnt, unread, has_att, starred, n_inbox, n_archive, n_sent, n_spam, n_trash, n_live,
       trash_at, delivery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       sort_at = MAX(excluded.last_at, COALESCE(threads.unsnoozed_at, 0)),
       last_at = excluded.last_at, last_id = excluded.last_id, last_folder = excluded.last_folder, last_mailbox = excluded.last_mailbox,
       last_from_addr = excluded.last_from_addr, last_from_name = excluded.last_from_name, last_to_addrs = excluded.last_to_addrs,
       subject = excluded.subject, snippet = excluded.snippet, participants = excluded.participants,
       mailboxes = excluded.mailboxes, domains = excluded.domains, cnt = excluded.cnt, unread = excluded.unread,
       has_att = excluded.has_att, starred = excluded.starred, n_inbox = excluded.n_inbox, n_archive = excluded.n_archive,
       n_sent = excluded.n_sent, n_spam = excluded.n_spam, n_trash = excluded.n_trash, n_live = excluded.n_live,
       trash_at = excluded.trash_at, delivery = excluded.delivery`,
  ).bind(
    tid,
    lastAt,
    lastAt,
    last.id,
    last.folder,
    last.mailbox,
    last.from_addr,
    last.from_name,
    last.to_addrs,
    titleMsg.subject,
    last.snippet,
    JSON.stringify(people),
    "," + boxes.join(",") + ",",
    "," + domains.join(",") + ",",
    scope.length,
    live.filter((m) => m.folder === "inbox" && !m.is_read && !m.spam).length,
    scope.some((m) => m.has_attachments) ? 1 : 0,
    live.some((m) => m.starred) ? 1 : 0,
    live.filter((m) => m.folder === "inbox" && !m.archived && !m.spam).length,
    live.filter((m) => m.folder === "inbox" && m.archived && !m.spam).length,
    live.filter((m) => m.folder === "sent").length,
    live.filter((m) => m.spam).length,
    trash.length,
    live.length,
    trash.length ? Math.max(...trash.map((m) => m.deleted_at!)) : null,
    lastSent?.delivery_status ?? null,
  );
}

export async function refreshMailboxStats(env: Env, mailboxes: string[]): Promise<void> {
  const boxes = [...new Set(mailboxes.filter(Boolean))];
  for (const part of chunk(boxes, 80)) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM mailbox_stats WHERE mailbox IN (${placeholders(part.length)})`).bind(...part),
      env.DB.prepare(
        `INSERT INTO mailbox_stats (mailbox, domain, total, unread, spam, last_at)
         SELECT mailbox, domain, COUNT(*),
           SUM(CASE WHEN folder = 'inbox' AND is_read = 0 AND archived = 0 AND spam = 0 THEN 1 ELSE 0 END),
           SUM(spam),
           -- last_at：最近一封"进入收件箱"的邮件时间，前端轮询据此提示新邮件（不含已发送、垃圾邮件、被规则归档的邮件）
           COALESCE(MAX(CASE WHEN folder = 'inbox' AND spam = 0 AND archived = 0 THEN created_at END), 0)
         FROM messages WHERE mailbox IN (${placeholders(part.length)}) AND deleted_at IS NULL GROUP BY mailbox`,
      ).bind(...part),
    ]);
  }
}

// 改动若干邮件后统一刷新
export async function touch(env: Env, opts: { threads?: string[]; mailboxes?: string[]; messageIds?: string[] }): Promise<void> {
  let threads = opts.threads ?? [];
  let boxes = opts.mailboxes ?? [];
  if (opts.messageIds?.length) {
    for (const part of chunk(opts.messageIds, 90)) {
      const { results } = await env.DB.prepare(`SELECT thread_id, mailbox FROM messages WHERE id IN (${placeholders(part.length)})`)
        .bind(...part)
        .all<{ thread_id: string; mailbox: string }>();
      threads = threads.concat(results.map((r) => r.thread_id));
      boxes = boxes.concat(results.map((r) => r.mailbox));
    }
  }
  if (threads.length && !opts.mailboxes) {
    for (const part of chunk([...new Set(threads)], 90)) {
      const { results } = await env.DB.prepare(`SELECT DISTINCT mailbox FROM messages WHERE thread_id IN (${placeholders(part.length)})`)
        .bind(...part)
        .all<{ mailbox: string }>();
      boxes = boxes.concat(results.map((r) => r.mailbox));
    }
  }
  await refreshThreads(env, threads);
  await refreshMailboxStats(env, boxes);
}

// ---------- 回填（升级到汇总表后，首次运行时分批处理已有数据） ----------

export async function backfillStep(env: Env, budget = 300): Promise<{ done: boolean; processed: number }> {
  const state = (await getSetting(env, "backfill_v3")) ?? "0";
  if (state === "done") return { done: true, processed: 0 };
  const cursor = Number(state) || 0;
  const { results } = await env.DB.prepare(
    `SELECT rowid AS rid, id, thread_id, mailbox, subject, from_addr, from_name, to_addrs, cc_addrs, snippet
     FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  ).bind(cursor, budget).all<any>();
  if (!results.length) {
    await setSetting(env, "backfill_v3", "done");
    return { done: true, processed: 0 };
  }
  // 全文索引：正文从 R2 读取（读不到就用摘要）
  for (const m of results) {
    let body = m.snippet ?? "";
    try {
      const obj = await blobs(env).get(`msg/${m.id}/body.json`);
      if (obj) body = ((await obj.json<{ text?: string }>()).text ?? body) as string;
    } catch {}
    await indexMessage(env, m.rid, { subject: m.subject ?? "", people: peopleText(m.from_name, m.from_addr, m.to_addrs, m.cc_addrs, m.mailbox), body });
  }
  await refreshThreads(env, results.map((r) => r.thread_id));
  await refreshMailboxStats(env, results.map((r) => r.mailbox));
  await setSetting(env, "backfill_v3", String(results[results.length - 1].rid));
  return { done: false, processed: results.length };
}

export const backfillPending = async (env: Env) => (await getSetting(env, "backfill_v3")) !== "done";

export { now };
