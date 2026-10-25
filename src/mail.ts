// 邮件存储：元数据进 D1，正文与附件进 R2
import PostalMime, { addressParser, decodeWords, type Email } from "postal-mime";
import { detectBounce } from "./bounce";
import type { Env } from "./env";
import { aiIsSpam, applyRules, blocklistAction, loadRules, parseAuth, type RuleActions } from "./filters";
import { notifyNewMail } from "./push";
import { ftsStatement, peopleText } from "./search";
import { refreshThreads, touch } from "./threads";
import { chunk, domainOf, escapeRegExp, getSettings, htmlToText, logEvent, now, placeholders, randomId, sha256hex, snippetOf } from "./util";
import { blobs, putMany, type PutItem } from "./storage";

export interface StoredAttachment {
  filename: string;
  mimeType: string;
  size: number;
  key: string;
  contentId?: string; // 内嵌图片（HTML 里用 cid: 引用）
  inline?: boolean;
  missing?: boolean; // 收信时没能保存（下载时提示改用原始邮件）
}

export interface StoredBody {
  text: string;
  html: string | null;
  attachments: StoredAttachment[];
}

// 各语言常见的回复 / 转发前缀（Re、AW、SV、Antw、回复、答复……，以及 "RE[2]:" 这种计数写法）
const REPLY = "re|aw|sv|vs|antw|rif|ref|r|回复|答复|回覆";
const PREFIX = new RegExp(`^\\s*((${REPLY}|fw|fwd|wg|tr|rv|enc|転送|转发|轉寄)(\\[\\d+\\])?\\s*[:：]\\s*)+`, "i");
const normalizeSubject = (s: string) => s.replace(PREFIX, "").trim().toLowerCase();
const hasReplyPrefix = (s: string) => new RegExp(`^\\s*(${REPLY})(\\[\\d+\\])?\\s*[:：]`, "i").test(s);

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

// 会话归类：先按 Message-ID 引用；找不到时，同一地址、30 天内、主题相同且参与人有重叠才合并。
// 只在同一个地址内按引用合并：外部发件人可以随意填 References，不能让他把邮件塞进别的地址的会话
// （团队成员也因此不会通过会话看到权限以外的邮件）
async function resolveThread(env: Env, mailbox: string, refIds: string[], subject: string, party: string[]): Promise<string> {
  // In-Reply-To（排在最前）+ 最近 20 个引用，避免超过 D1 每条查询 100 个参数的上限
  const uniq = [...new Set(refIds)];
  const ids = uniq.length > 21 ? [uniq[0], ...uniq.slice(-20)] : uniq;
  if (ids.length) {
    const row = await env.DB.prepare(`SELECT thread_id FROM messages WHERE message_id IN (${placeholders(ids.length)}) AND mailbox = ? LIMIT 1`)
      .bind(...ids, mailbox)
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
// 分两步，保证邮件不会"静默丢失"：
//   1. 先存原文，并用信头建一条记录（parse_error = 'pending'）。之后无论解析、写附件还是写库出错，邮件都在，可以下载原文
//   2. 解析正文和附件，补全记录。免费版大邮件可能超出 CPU 限制被中断，这时记录停在 pending，由每分钟的定时任务收尾
// 邮件 id 由收件地址 + Message-ID 算出：重投时得到同一个 id，原文覆盖写入，不会留下孤儿文件

export interface IngestInput {
  raw: Uint8Array;
  rcpt: string; // 归属的地址（收件为收件地址，导入的已发送邮件为发件地址）
  envelopeFrom: string;
  headers: Headers;
  rawSize: number;
  source: "inbound" | "import";
  folder?: "inbox" | "sent";
  block?: "spam" | "reject" | null;
  markRead?: boolean;
}

export interface IngestResult {
  status: "stored" | "duplicate";
  id?: string;
  threadId?: string;
  forward?: string;
  notify?: boolean;
}

// 解析信头（导入的 .eml / mbox 没有现成的 Headers）
export function parseHeaderBlock(raw: Uint8Array): Headers {
  const head = new TextDecoder("latin1").decode(raw.subarray(0, Math.min(raw.length, 256 * 1024)));
  const endAt = head.search(/\r?\n\r?\n/);
  const block = (endAt >= 0 ? head.slice(0, endAt) : head).replace(/\r?\n[ \t]+/g, " ");
  const h = new Headers();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    try {
      h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
    } catch {}
  }
  return h;
}

// 没有 Message-ID 的邮件：用稳定的信头 + 正文开头算哈希（不含每次投递都不同的 Received 等信头）
async function stableMessageId(raw: Uint8Array, h: Headers): Promise<string> {
  let bodyAt = 0;
  for (let i = 0; i + 3 < raw.length && i < 512 * 1024; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      bodyAt = i + 4;
      break;
    }
    if (raw[i] === 10 && raw[i + 1] === 10) {
      bodyAt = i + 2;
      break;
    }
  }
  const stable = ["date", "from", "to", "subject"].map((k) => h.get(k) ?? "").join("\n");
  const enc = new TextEncoder().encode(stable + "\n" + (raw.length - bodyAt) + "\n");
  const body = raw.subarray(bodyAt, bodyAt + 64 * 1024);
  const buf = new Uint8Array(enc.length + body.length);
  buf.set(enc);
  buf.set(body, enc.length);
  return `<sha256.${(await sha256hex(buf)).slice(0, 40)}@no-message-id>`;
}

const decodeHeader = (v: string | null) => {
  if (!v) return "";
  try {
    return decodeWords(v);
  } catch {
    return v;
  }
};

function headerFrom(h: Headers, fallback: string): { address: string; name: string | null } {
  try {
    const list = addressParser(h.get("from") ?? "") as { address?: string; name?: string; group?: unknown[] }[];
    const first = list.find((a) => a.address);
    if (first?.address) return { address: first.address.toLowerCase(), name: first.name ? decodeHeader(first.name) : null };
  } catch {}
  return { address: fallback.toLowerCase(), name: null };
}

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
  const state = { persisted: false };
  let res: IngestResult;
  try {
    res = await ingest(env, { raw, rcpt, envelopeFrom, headers: message.headers, rawSize: message.rawSize, source: "inbound", block }, state);
  } catch (e: any) {
    const detail = { to: rcpt, from: envelopeFrom, subject: decodeHeader(message.headers.get("subject")).slice(0, 200), size: message.rawSize, error: String(e?.message ?? e).slice(0, 500), saved: state.persisted };
    console.error("inbound failed", detail);
    await logEvent(env, "inbound_error", detail);
    // 已经存下原文和记录：邮件在收件箱里，补全工作交给定时任务；否则抛出，让发件方稍后重投
    if (state.persisted) return;
    throw e;
  }
  if (res.status !== "stored") return;
  if (res.forward) {
    try {
      await message.forward(res.forward);
    } catch (e) {
      console.warn("rule forward failed", res.forward, e);
    }
  }
  if (res.notify && !addrRow?.muted) {
    const p = notifyNewMail(env, rcpt, null).catch(() => {});
    if (ctx) ctx.waitUntil(p);
    else await p;
  }
}

export async function ingest(env: Env, input: IngestInput, state: { persisted: boolean } = { persisted: false }): Promise<IngestResult> {
  const { raw, rcpt, headers: hdr } = input;
  const folder = input.folder ?? "inbox";
  const domain = domainOf(rcpt);
  const messageId = hdr.get("message-id")?.trim() || (await stableMessageId(raw, hdr));

  // 去重：已经收过的直接返回（顺便修复缺失的会话汇总）；上次中断在 pending 的继续处理
  const existing = await env.DB.prepare(
    `SELECT m.id, m.rowid AS rid, m.thread_id, m.parse_error, EXISTS (SELECT 1 FROM threads t WHERE t.thread_id = m.thread_id) AS has_thread
     FROM messages m WHERE m.message_id = ? AND m.mailbox = ? AND m.folder = ? LIMIT 1`,
  ).bind(messageId, rcpt, folder).first<{ id: string; rid: number; thread_id: string; parse_error: string | null; has_thread: number }>();
  if (existing && existing.parse_error !== "pending") {
    if (!existing.has_thread) await refreshThreads(env, [existing.thread_id]);
    return { status: "duplicate" };
  }

  const settings = await getSettings(env, ["pref_spam_score", "pref_ai_spam"]);
  const threshold = settings.pref_spam_score && !Number.isNaN(Number(settings.pref_spam_score)) ? Number(settings.pref_spam_score) : null;
  const auth = parseAuth(hdr);
  const preSpam = input.source === "inbound" && (input.block === "spam" || auth.dmarc === "fail" || (threshold !== null && auth.score !== undefined && auth.score >= threshold));
  const hFrom = headerFrom(hdr, input.envelopeFrom);
  const hSubject = decodeHeader(hdr.get("subject"));
  const hInReplyTo = hdr.get("in-reply-to")?.trim() || null;
  const hRefs = hdr.get("references")?.trim() || null;

  let id: string;
  let rowid: number;
  let threadId: string;
  if (existing) {
    ({ id, rid: rowid, thread_id: threadId } = existing);
    state.persisted = true;
  } else {
    id = (await sha256hex(`${rcpt}\n${folder}\n${messageId}`)).slice(0, 32);
    await blobs(env).put(`msg/${id}/raw.eml`, raw, { httpMetadata: { contentType: "message/rfc822" } });
    threadId = await resolveThread(env, rcpt, [...parseRefs(hInReplyTo), ...parseRefs(hRefs)], hSubject, [hFrom.address]);
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO messages (id, folder, mailbox, domain, from_addr, from_name, to_addrs, subject, snippet, message_id, in_reply_to, refs,
         thread_id, has_attachments, size, is_read, spam, auth, parse_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 0, ?, ?, ?, ?, 'pending', ?) RETURNING rowid`,
    )
      .bind(
        id, folder, rcpt, domain, hFrom.address, hFrom.name, JSON.stringify([{ address: rcpt }]), hSubject, messageId, hInReplyTo, hRefs, threadId,
        input.rawSize, folder === "sent" || input.markRead || preSpam ? 1 : 0, preSpam ? 1 : 0, JSON.stringify(auth), messageDate(hdr, input.source),
      )
      .first<{ rowid: number }>();
    // 并发重投：另一份正在处理（id 相同，文件也是同一份）
    if (!ins) return { status: "duplicate" };
    rowid = ins.rowid;
    state.persisted = true;
  }

  // ---- 第 2 步：解析 ----
  let parsed: Email | null = null;
  let parseError: string | null = null;
  try {
    parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  } catch (e: any) {
    parseError = String(e?.message ?? e).slice(0, 300) || "parse failed";
  }

  const attachments: StoredAttachment[] = [];
  const puts: PutItem[] = [];
  let html: string | null = null;
  let text = "";
  if (parsed) {
    for (const [i, a] of parsed.attachments.entries()) {
      const key = `msg/${id}/att/${i}`;
      const content = a.content as ArrayBuffer;
      puts.push({ key, value: content, opts: { httpMetadata: { contentType: a.mimeType } } });
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
  // 附件写入失败的标记出来（下载时提示改用原始邮件），不影响收信
  const failedAtt = new Set(await putMany(env, puts));
  for (const a of attachments) if (failedAtt.has(a.key)) a.missing = true;
  if (failedAtt.size) parseError ??= `${failedAtt.size} 个附件保存失败`;
  const bodyFailed = (await putMany(env, [{ key: `msg/${id}/body.json`, value: JSON.stringify({ text, html, attachments } satisfies StoredBody), opts: { httpMetadata: { contentType: "application/json" } } }])).length > 0;
  if (bodyFailed) parseError = "正文保存失败";

  const subject = parsed?.subject ?? hSubject;
  const fromAddr = (parsed?.from?.address ?? hFrom.address).toLowerCase();
  const fromName = parsed?.from?.name || hFrom.name;
  const inReplyTo = parsed?.inReplyTo?.trim() || hInReplyTo;
  const refs = parsed?.references?.trim() || hRefs;
  const listUnsub = parseListUnsub(hdr);
  const realAttachments = attachments.filter((a) => !isInlineShown(a, html)).length;
  const stmts: D1PreparedStatement[] = [];
  const oldThread = threadId;

  // 退信：关联到原邮件，并标记原邮件投递失败
  let isBounce = 0;
  const bounce = parsed && input.source === "inbound" ? detectBounce(parsed, input.envelopeFrom, hdr.get("content-type")) : null;
  if (bounce) {
    isBounce = 1;
    let orig: { id: string; thread_id: string } | null = null;
    if (bounce.originalMessageId) {
      orig = await env.DB.prepare("SELECT id, thread_id FROM messages WHERE folder = 'sent' AND message_id = ?").bind(bounce.originalMessageId).first();
    }
    // LIKE 模式最长 50 字节（D1 限制），地址太长时用 instr 匹配
    if (!orig && bounce.recipient) {
      orig = await env.DB.prepare(
        "SELECT id, thread_id FROM messages WHERE folder = 'sent' AND mailbox = ? AND created_at > ? AND instr(to_addrs, ?) > 0 ORDER BY created_at DESC LIMIT 1",
      ).bind(rcpt, now() - 3 * 86400, `"${bounce.recipient}"`).first();
    }
    if (orig) {
      threadId = orig.thread_id;
      if (bounce.permanent) {
        const detail = [bounce.recipient, bounce.status, bounce.diagnostic].filter(Boolean).join(" · ");
        stmts.push(env.DB.prepare("UPDATE messages SET delivery_status = 'bounced', delivery_detail = ? WHERE id = ?").bind(detail, orig.id));
      }
    }
  }

  // 规则与垃圾判定（导入的邮件不做判定）
  let actions: RuleActions = { labels: [] };
  let matched: string[] = [];
  let spam = preSpam;
  if (input.source === "inbound") {
    const rules = await loadRules(env);
    ({ actions, matched } = applyRules(rules, { to: rcpt, from: fromAddr, fromName: fromName ?? "", subject, body: text.slice(0, 5000), hasAttachment: realAttachments > 0 }));
    spam ||= actions.spam === true;
    if (!spam && !isBounce && settings.pref_ai_spam === "1") {
      const known = await env.DB.prepare("SELECT 1 FROM contacts WHERE address = ? LIMIT 1").bind(fromAddr).first();
      if (!known) spam = await aiIsSpam(env, { from: fromAddr, subject, text });
    }
  }
  const isRead = folder === "sent" || input.markRead || actions.read || spam;

  stmts.push(
    env.DB.prepare(
      `UPDATE messages SET from_addr = ?, from_name = ?, reply_to = ?, to_addrs = ?, cc_addrs = ?, subject = ?, snippet = ?, in_reply_to = ?, refs = ?,
         thread_id = ?, has_attachments = ?, is_read = ?, starred = ?, archived = ?, spam = ?, list_unsub = ?, is_bounce = ?, parse_error = ?, att_count = ?
       WHERE id = ?`,
    ).bind(
      fromAddr, fromName, parsed?.replyTo?.[0]?.address?.toLowerCase() ?? null, addrList(parsed?.to ?? [{ address: rcpt }]), addrList(parsed?.cc), subject,
      snippetOf(text), inReplyTo, refs, threadId, realAttachments ? 1 : 0, isRead ? 1 : 0, actions.star ? 1 : 0, actions.archive ? 1 : 0, spam ? 1 : 0,
      listUnsub, isBounce, parseError, attachments.length, id,
    ),
    addressUpsert(env, rcpt, domain),
    ftsStatement(env, rowid, {
      subject,
      people: peopleText(fromName, fromAddr, rcpt, (parsed?.to ?? []).map((t) => `${t.name ?? ""} ${t.address ?? ""}`).join(" ")),
      body: text,
    }),
  );
  if (folder === "inbox" && !spam && !isBounce) stmts.push(await upsertContact(env, domain, fromAddr, fromName));
  if (folder === "sent") for (const t of parsed?.to ?? []) if (t.address) stmts.push(await upsertContact(env, domain, t.address, t.name));
  for (const l of actions.labels ?? []) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO thread_labels (thread_id, label_id) VALUES (?, ?)").bind(threadId, l));
  // 设置了"稍后提醒"的会话收到新回复：立即回到收件箱
  if (folder === "inbox" && !spam && !actions.archive) {
    stmts.push(env.DB.prepare("UPDATE threads SET snooze_until = NULL, unsnoozed_at = ? WHERE thread_id = ? AND snooze_until IS NOT NULL").bind(now(), threadId));
  }
  for (const r of matched) stmts.push(env.DB.prepare("UPDATE rules SET hits = hits + 1 WHERE id = ?").bind(r));
  await env.DB.batch(stmts);
  await refreshThreads(env, threadId === oldThread ? [threadId] : [threadId, oldThread]);

  return {
    status: "stored",
    id,
    threadId,
    forward: input.source === "inbound" ? actions.forward : undefined,
    notify: input.source === "inbound" && folder === "inbox" && !spam && !actions.archive && !actions.mute,
  };
}

// 导入的邮件用信头里的日期（限制在合理范围内），收到的新邮件用当前时间
function messageDate(h: Headers, source: IngestInput["source"]): number {
  if (source !== "import") return now();
  const t = Date.parse(h.get("date") ?? "");
  return Number.isFinite(t) && t > 0 && t < Date.now() + 86400_000 ? Math.floor(t / 1000) : now();
}

// 中断在 pending 的邮件（大邮件超出 CPU 限制等）：2 分钟后由定时任务收尾，让它在列表里可见
export async function finalizeStale(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, thread_id, mailbox, subject FROM messages WHERE parse_error = 'pending' AND created_at < ? LIMIT 20",
  ).bind(now() - 120).all<{ id: string; thread_id: string; mailbox: string; subject: string | null }>();
  if (!results.length) return 0;
  await env.DB.batch(
    results.map((r) =>
      env.DB.prepare("UPDATE messages SET parse_error = 'timeout', snippet = ? WHERE id = ? AND parse_error = 'pending'").bind(
        "（邮件内容较大，没能在限定时间内解析完成。可以在「更多」菜单中下载原始邮件查看。）",
        r.id,
      ),
    ),
  );
  await refreshThreads(env, results.map((r) => r.thread_id));
  for (const r of results) await logEvent(env, "inbound_timeout", { id: r.id, to: r.mailbox, subject: r.subject });
  return results.length;
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
  const attachments: StoredAttachment[] = m.attachments.map((a, i) => ({ filename: a.filename, mimeType: a.type, size: a.data.byteLength, key: `msg/${id}/att/${i}` }));
  const body: StoredBody = { text: m.text, html: m.html ?? null, attachments };
  const failed = new Set(
    await putMany(env, [
      ...m.attachments.map((a, i) => ({ key: attachments[i].key, value: a.data, opts: { httpMetadata: { contentType: a.type } } })),
      { key: `msg/${id}/body.json`, value: JSON.stringify(body), opts: { httpMetadata: { contentType: "application/json" } } },
    ]),
  );
  if (failed.has(`msg/${id}/body.json`)) throw new Error("正文保存失败");
  for (const a of attachments) if (failed.has(a.key)) a.missing = true;

  const mailbox = m.from.email.toLowerCase();
  const domain = domainOf(mailbox);
  const threadId = m.threadId ?? (await resolveThread(env, mailbox, [], m.subject, [...m.to, ...m.cc]));
  const pmid = m.providerMessageId;
  // 优先用发件服务实际使用的 Message-ID，其次是我们自己生成的（对方回复时靠它归到同一个会话）
  const messageId = (pmid && pmid.includes("@") ? (pmid.startsWith("<") ? pmid : `<${pmid}>`) : null) ?? m.messageId;
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
  if (ins) stmts.push(ftsStatement(env, ins.rowid, { subject: m.subject, people: peopleText(m.from.name, mailbox, ...m.to, ...m.cc), body: m.text }));
  await env.DB.batch(stmts);
  await refreshThreads(env, [threadId]);
  return { id, threadId };
}

// ================= 彻底删除 =================

// 先删 D1（保证重试不会卡在已清理的数据上），再按已知的 key 批量删文件；删除失败的 key 记下来由定时任务重试
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
      // 整个会话都删光了的，会话汇总在同一个事务里一起删掉：之后刷新汇总时即使 D1 临时出错，也不会留下"幽灵会话"
      const tids = [...new Set(results.map((r) => r.thread_id))];
      const orphan = (table: string) =>
        env.DB.prepare(`DELETE FROM ${table} WHERE thread_id IN (${placeholders(tids.length)}) AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = ${table}.thread_id)`).bind(...tids);
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM messages_fts WHERE rowid IN (${placeholders(results.length)})`).bind(...results.map((r) => r.rid)),
        env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders(results.length)})`).bind(...results.map((r) => r.id)),
        orphan("thread_labels"),
        orphan("threads"),
      ]);
    }
  }
  await deleteBlobs(env, keys);
  await touch(env, { threads: touched.map((t) => t.thread_id) });
}

export async function deleteBlobs(env: Env, keys: string[]): Promise<void> {
  for (const part of chunk(keys, 1000)) {
    try {
      await blobs(env).delete(part);
    } catch {
      for (const k of chunk(part, 90)) {
        await env.DB.prepare(`INSERT OR IGNORE INTO blob_trash (key, created_at) VALUES ${k.map(() => "(?, ?)").join(",")}`)
          .bind(...k.flatMap((x) => [x, now()]))
          .run()
          .catch(() => {});
      }
    }
  }
}

// 重试之前没删掉的文件
export async function retryBlobTrash(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT key FROM blob_trash ORDER BY created_at LIMIT 200").all<{ key: string }>();
  if (!results.length) return;
  const keys = results.map((r) => r.key);
  await blobs(env).delete(keys);
  for (const part of chunk(keys, 90)) await env.DB.prepare(`DELETE FROM blob_trash WHERE key IN (${placeholders(part.length)})`).bind(...part).run();
}
