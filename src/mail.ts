// 邮件存储：元数据进 D1，正文与附件进 R2
import PostalMime, { type Email } from "postal-mime";
import { detectBounce } from "./bounce";
import type { Env } from "./env";
import { aiIsSpam, applyRules, blocklistAction, bumpRuleHits, loadRules, parseAuth, spamThreshold, type RuleActions } from "./filters";
import { notifyNewMail } from "./push";
import { indexMessage, peopleText } from "./search";
import { refreshMailboxStats, refreshThreads, touch } from "./threads";
import { chunk, domainOf, escapeRegExp, htmlToText, now, placeholders, randomId, sha256hex, snippetOf } from "./util";
import { blobs } from "./storage";

export interface StoredAttachment {
  filename: string;
  mimeType: string;
  size: number;
  key: string;
  contentId?: string; // 内嵌图片（HTML 里用 cid: 引用）
  inline?: boolean;
}

export interface StoredBody {
  text: string;
  html: string | null;
  attachments: StoredAttachment[];
}

const normalizeSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/i, "").trim().toLowerCase();
const hasReplyPrefix = (s: string) => /^\s*(re|回复|答复)\s*[:：]/i.test(s);

export function parseRefs(s: string | null | undefined): string[] {
  return (s ?? "").match(/<[^<>\s]+>/g) ?? [];
}

// cid 精确匹配：cid:img1 不能误伤 cid:img10
export function cidPattern(cid: string): RegExp {
  return new RegExp(`cid:${escapeRegExp(cid)}(?=["'\\s>)]|$)`, "gi");
}
export function isInlineShown(a: StoredAttachment, html: string | null): boolean {
  if (!a.contentId || !html) return false;
  return cidPattern(a.contentId).test(html);
}

// 会话归类：先按 Message-ID 引用；找不到时，同一地址、30 天内、主题相同且参与人有重叠才合并
async function resolveThread(env: Env, mailbox: string, refIds: string[], subject: string, party: string[]): Promise<string> {
  // In-Reply-To + 最近 20 个引用，避免超过 D1 每条查询 100 个参数的上限
  const ids = [...new Set(refIds)].slice(-21);
  if (ids.length) {
    const row = await env.DB.prepare(`SELECT thread_id FROM messages WHERE message_id IN (${placeholders(ids.length)}) LIMIT 1`)
      .bind(...ids)
      .first<{ thread_id: string }>();
    if (row) return row.thread_id;
  }
  if (hasReplyPrefix(subject) && party.length) {
    const rows = await env.DB.prepare(
      `SELECT thread_id, subject, folder, from_addr, to_addrs, cc_addrs FROM messages
       WHERE mailbox = ? AND created_at > ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
    ).bind(mailbox, now() - 30 * 86400).all<{ thread_id: string; subject: string; folder: string; from_addr: string; to_addrs: string; cc_addrs: string | null }>();
    const target = normalizeSubject(subject);
    const ps = new Set(party.map((p) => p.toLowerCase()));
    const hit = rows.results.find((r) => {
      if (normalizeSubject(r.subject ?? "") !== target) return false;
      const theirs = r.folder === "sent" ? [...(r.to_addrs + (r.cc_addrs ?? "")).matchAll(/"address":"([^"]+)"/g)].map((x) => x[1]) : [r.from_addr];
      return theirs.some((a) => ps.has(a.toLowerCase()));
    });
    if (hit) return hit.thread_id;
  }
  return randomId(12);
}

const addrList = (xs?: { address?: string; name?: string }[]) =>
  JSON.stringify((xs ?? []).filter((x) => x.address).map((x) => ({ address: x.address!.toLowerCase(), name: x.name || undefined })));

function parseListUnsub(headers: Headers): string | null {
  const v = headers.get("list-unsubscribe");
  if (!v) return null;
  const url = v.match(/<(https:\/\/[^>]+)>/i)?.[1] ?? null;
  const mailto = v.match(/<mailto:([^>]+)>/i)?.[1] ?? null;
  if (!url && !mailto) return null;
  const oneClick = /one-click/i.test(headers.get("list-unsubscribe-post") ?? "");
  return JSON.stringify({ url, mailto, oneClick });
}

async function upsertContact(env: Env, domain: string, address: string, name: string | null | undefined): Promise<D1PreparedStatement> {
  return env.DB.prepare(
    `INSERT INTO contacts (domain, address, name, n, last_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (domain, address) DO UPDATE SET n = n + 1, last_at = excluded.last_at, name = COALESCE(excluded.name, contacts.name)`,
  ).bind(domain, address.toLowerCase(), name || null, now());
}

function addressUpsert(env: Env, address: string, domain: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO addresses (address, domain, first_at, last_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET last_at = excluded.last_at`,
  ).bind(address, domain, now(), now());
}

// ================= 收信 =================

export async function handleInbound(message: ForwardableEmailMessage, env: Env, ctx?: ExecutionContext): Promise<void> {
  // 拒收前先关闭邮件内容流，否则运行时会一直等待它被读取
  const reject = async (reason: string) => {
    await message.raw.cancel().catch(() => {});
    message.setReject(reason);
  };
  const rcpt = message.to.toLowerCase();
  const domain = domainOf(rcpt);
  const [configured, addrRow] = await Promise.all([
    env.DB.prepare("SELECT 1 FROM domains WHERE name = ?").bind(domain).first(),
    env.DB.prepare("SELECT blocked, muted FROM addresses WHERE address = ?").bind(rcpt).first<{ blocked: number; muted: number }>(),
  ]);
  if (!configured) return reject("Mailbox not configured");
  if (addrRow?.blocked) return reject("Address disabled");

  const envelopeFrom = message.from.toLowerCase();
  const block = await blocklistAction(env, envelopeFrom);
  if (block === "reject") return reject("Sender blocked");

  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  // 没有 Message-ID 的邮件用内容哈希代替，保证重投递能去重
  const messageId = message.headers.get("message-id")?.trim() || `<sha256.${(await sha256hex(raw)).slice(0, 40)}@no-message-id>`;
  const dup = await env.DB.prepare("SELECT 1 FROM messages WHERE message_id = ? AND mailbox = ? AND folder = 'inbox'").bind(messageId, rcpt).first();
  if (dup) return;

  const id = randomId(16);
  await blobs(env).put(`msg/${id}/raw.eml`, raw, { httpMetadata: { contentType: "message/rfc822" } });

  // 解析失败时也要入库：用信头里的信息建一条记录，原始邮件可以下载查看
  let parsed: Email | null = null;
  let parseError: string | null = null;
  try {
    parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  } catch (e: any) {
    parseError = String(e?.message ?? e).slice(0, 300);
  }

  const attachments: StoredAttachment[] = [];
  let html: string | null = null;
  let text = "";
  if (parsed) {
    for (const [i, a] of parsed.attachments.entries()) {
      const key = `msg/${id}/att/${i}`;
      const content = a.content as ArrayBuffer;
      await blobs(env).put(key, content, { httpMetadata: { contentType: a.mimeType } });
      attachments.push({
        filename: a.filename ?? `attachment-${i + 1}`,
        mimeType: a.mimeType,
        size: content.byteLength,
        key,
        contentId: a.contentId?.replace(/^<|>$/g, "") || undefined,
        inline: a.disposition === "inline" || a.related || undefined,
      });
    }
    html = parsed.html ?? null;
    text = parsed.text ?? (html ? htmlToText(html) : "");
  } else {
    text = "（这封邮件的格式无法解析，可以在「更多」菜单中下载原始邮件查看。）";
  }
  await blobs(env).put(`msg/${id}/body.json`, JSON.stringify({ text, html, attachments } satisfies StoredBody), {
    httpMetadata: { contentType: "application/json" },
  });

  const hdr = message.headers;
  const decodeHeader = (v: string | null) => v ?? "";
  const subject = parsed?.subject ?? decodeHeader(hdr.get("subject"));
  const fromAddr = (parsed?.from?.address ?? envelopeFrom).toLowerCase();
  const fromName = parsed?.from?.name || null;
  const inReplyTo = parsed?.inReplyTo?.trim() || hdr.get("in-reply-to") || null;
  const refs = parsed?.references?.trim() || hdr.get("references") || null;
  const auth = parseAuth(hdr);
  const listUnsub = parseListUnsub(hdr);
  const realAttachments = attachments.filter((a) => !isInlineShown(a, html)).length;

  // 退信：关联到原邮件，并标记原邮件投递失败
  let threadId: string | null = null;
  let isBounce = 0;
  const bounce = parsed ? detectBounce(parsed, envelopeFrom, hdr.get("content-type")) : null;
  if (bounce) {
    isBounce = 1;
    let orig: { id: string; thread_id: string } | null = null;
    if (bounce.originalMessageId) {
      orig = await env.DB.prepare("SELECT id, thread_id FROM messages WHERE folder = 'sent' AND message_id = ?").bind(bounce.originalMessageId).first();
    }
    if (!orig && bounce.recipient) {
      orig = await env.DB.prepare(
        "SELECT id, thread_id FROM messages WHERE folder = 'sent' AND mailbox = ? AND to_addrs LIKE ? AND created_at > ? ORDER BY created_at DESC LIMIT 1",
      ).bind(rcpt, `%"${bounce.recipient}"%`, now() - 3 * 86400).first();
    }
    if (orig) {
      threadId = orig.thread_id;
      if (bounce.permanent) {
        const detail = [bounce.recipient, bounce.status, bounce.diagnostic].filter(Boolean).join(" · ");
        await env.DB.prepare("UPDATE messages SET delivery_status = 'bounced', delivery_detail = ? WHERE id = ?").bind(detail, orig.id).run();
      }
    }
  }

  // 规则与垃圾判定
  const rules = await loadRules(env);
  const { actions, matched } = applyRules(rules, { to: rcpt, from: fromAddr, fromName: fromName ?? "", subject, body: text.slice(0, 5000), hasAttachment: realAttachments > 0 });
  const threshold = await spamThreshold(env);
  let spam =
    block === "spam" ||
    actions.spam === true ||
    auth.dmarc === "fail" ||
    (threshold !== null && auth.score !== undefined && auth.score >= threshold);
  if (!spam && !isBounce) {
    const known = await env.DB.prepare("SELECT 1 FROM contacts WHERE address = ? LIMIT 1").bind(fromAddr).first();
    if (!known) spam = await aiIsSpam(env, { from: fromAddr, subject, text });
  }

  threadId ??= await resolveThread(env, rcpt, [...parseRefs(inReplyTo), ...parseRefs(refs)], subject, [fromAddr]);
  const ts = now();
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, folder, mailbox, domain, from_addr, from_name, reply_to, to_addrs, cc_addrs, subject, snippet,
       message_id, in_reply_to, refs, thread_id, has_attachments, size, is_read, starred, archived, spam, auth, list_unsub,
       is_bounce, parse_error, att_count, created_at)
     VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING rowid`,
  )
    .bind(
      id,
      rcpt,
      domain,
      fromAddr,
      fromName,
      parsed?.replyTo?.[0]?.address?.toLowerCase() ?? null,
      addrList(parsed?.to ?? [{ address: rcpt }]),
      addrList(parsed?.cc),
      subject,
      snippetOf(text),
      messageId,
      inReplyTo,
      refs,
      threadId,
      realAttachments ? 1 : 0,
      message.rawSize,
      actions.read || spam ? 1 : 0,
      actions.star ? 1 : 0,
      actions.archive ? 1 : 0,
      spam ? 1 : 0,
      JSON.stringify(auth),
      listUnsub,
      isBounce,
      parseError,
      attachments.length,
      ts,
    )
    .first<{ rowid: number }>();
  if (!ins) {
    // 并发重投：另一份已入库，清理本次写入的文件
    await blobs(env).delete([`msg/${id}/raw.eml`, `msg/${id}/body.json`, ...attachments.map((a) => a.key)]);
    return;
  }

  const stmts = [addressUpsert(env, rcpt, domain)];
  if (!spam && !isBounce) stmts.push(await upsertContact(env, domain, fromAddr, fromName));
  for (const l of actions.labels ?? []) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO thread_labels (thread_id, label_id) VALUES (?, ?)").bind(threadId, l));
  await env.DB.batch(stmts);
  await indexMessage(env, ins.rowid, {
    subject,
    people: peopleText(fromName, fromAddr, rcpt, (parsed?.to ?? []).map((t) => `${t.name ?? ""} ${t.address ?? ""}`).join(" ")),
    body: text,
  });
  await refreshThreads(env, [threadId]);
  await refreshMailboxStats(env, [rcpt]);
  await bumpRuleHits(env, matched);

  if (actions.forward) {
    try {
      await message.forward(actions.forward);
    } catch (e) {
      console.warn("rule forward failed", actions.forward, e);
    }
  }
  if (!spam && !actions.archive && !actions.mute && !addrRow?.muted) {
    const p = notifyNewMail(env, rcpt, null).catch(() => {});
    if (ctx) ctx.waitUntil(p);
    else await p;
  }
}

// ================= 发件存档 =================

export interface SentAttachment {
  filename: string;
  type: string;
  data: Uint8Array;
}

export async function storeSent(
  env: Env,
  m: {
    from: { email: string; name?: string };
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    text: string;
    html?: string;
    inReplyTo: string | null;
    refs: string | null;
    threadId: string | null;
    provider: string;
    providerMessageId: string | null;
    messageId: string | null;
    attachments: SentAttachment[];
  },
): Promise<{ id: string; threadId: string }> {
  const id = randomId(16);
  const attachments: StoredAttachment[] = [];
  for (const [i, a] of m.attachments.entries()) {
    const key = `msg/${id}/att/${i}`;
    await blobs(env).put(key, a.data, { httpMetadata: { contentType: a.type } });
    attachments.push({ filename: a.filename, mimeType: a.type, size: a.data.byteLength, key });
  }
  const body: StoredBody = { text: m.text, html: m.html ?? null, attachments };
  await blobs(env).put(`msg/${id}/body.json`, JSON.stringify(body), { httpMetadata: { contentType: "application/json" } });

  const mailbox = m.from.email.toLowerCase();
  const domain = domainOf(mailbox);
  const threadId = m.threadId ?? (await resolveThread(env, mailbox, [], m.subject, [...m.to, ...m.cc]));
  const pmid = m.providerMessageId;
  const messageId = m.messageId ?? (pmid && pmid.includes("@") ? (pmid.startsWith("<") ? pmid : `<${pmid}>`) : null);
  const addrs = (xs: string[]) => JSON.stringify(xs.map((address) => ({ address })));
  const ins = await env.DB.prepare(
    `INSERT INTO messages (id, folder, mailbox, domain, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, subject, snippet,
       message_id, in_reply_to, refs, thread_id, has_attachments, size, is_read, provider, provider_id, delivery_status, att_count, created_at)
     VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'sent', ?, ?) RETURNING rowid`,
  )
    .bind(
      id,
      mailbox,
      domain,
      mailbox,
      m.from.name ?? null,
      addrs(m.to),
      addrs(m.cc),
      m.bcc.length ? addrs(m.bcc) : null,
      m.subject,
      snippetOf(m.text),
      messageId,
      m.inReplyTo,
      m.refs,
      threadId,
      attachments.length ? 1 : 0,
      m.text.length + (m.html?.length ?? 0) + attachments.reduce((s, a) => s + a.size, 0),
      m.provider,
      pmid,
      attachments.length,
      now(),
    )
    .first<{ rowid: number }>();
  const stmts = [addressUpsert(env, mailbox, domain)];
  for (const a of [...m.to, ...m.cc, ...m.bcc]) stmts.push(await upsertContact(env, domain, a, null));
  await env.DB.batch(stmts);
  if (ins) await indexMessage(env, ins.rowid, { subject: m.subject, people: peopleText(m.from.name, mailbox, ...m.to, ...m.cc), body: m.text });
  await refreshThreads(env, [threadId]);
  await refreshMailboxStats(env, [mailbox]);
  return { id, threadId };
}

// ================= 彻底删除 =================

// 先删 D1（保证重试不会卡在已清理的数据上），再按已知的 key 批量删 R2
export async function purgeMessages(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const keys: string[] = [];
  const touched: { thread_id: string; mailbox: string }[] = [];
  for (const part of chunk(ids, 90)) {
    const { results } = await env.DB.prepare(
      `SELECT id, rowid AS rid, thread_id, mailbox, att_count, has_attachments FROM messages WHERE id IN (${placeholders(part.length)})`,
    ).bind(...part).all<{ id: string; rid: number; thread_id: string; mailbox: string; att_count: number | null; has_attachments: number }>();
    for (const r of results) {
      keys.push(`msg/${r.id}/raw.eml`, `msg/${r.id}/body.json`);
      if (r.att_count === null && r.has_attachments) {
        const listed = await blobs(env).list({ prefix: `msg/${r.id}/att/` });
        keys.push(...listed.objects.map((o) => o.key));
      } else for (let i = 0; i < (r.att_count ?? 0); i++) keys.push(`msg/${r.id}/att/${i}`);
      touched.push(r);
    }
    if (results.length) {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM messages_fts WHERE rowid IN (${placeholders(results.length)})`).bind(...results.map((r) => r.rid)),
        env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders(results.length)})`).bind(...results.map((r) => r.id)),
      ]);
    }
  }
  for (const part of chunk(keys, 1000)) await blobs(env).delete(part).catch(() => {});
  await touch(env, { threads: touched.map((t) => t.thread_id), mailboxes: touched.map((t) => t.mailbox) });
}
