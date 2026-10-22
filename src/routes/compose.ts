// 写信相关：附件上传、草稿、联系人补全、发件身份、模板、发送、定时发送
import { Hono } from "hono";
import type { AppEnv, Env, Scope } from "../env";
import { parseRefs, storeSent, type SentAttachment, type StoredBody } from "../mail";
import { SendError, sendVia, type Outgoing, type Provider } from "../providers";
import { canUseAddress, FULL, parseScope } from "../scope";
import { b64encode, domainOf, isEmail, now, placeholders, randomId } from "../util";
import { blobs } from "../storage";

export const compose = new Hono<AppEnv>();

const MAX_UPLOAD = 25 * 1024 * 1024;
// 估算 MIME 编码后的大小：附件 base64 后约为 4/3，再留一点头部余量
export const LIMITS: Record<Provider, number> = {
  cloudflare: 5 * 1024 * 1024,
  resend: 20 * 1024 * 1024, // Resend 上限 40MB，但 Worker 内存 128MB，需要多份拷贝，保守取 20MB
  none: 0,
};
export const encodedSize = (bytes: number) => Math.ceil(bytes * 1.37) + 2048;

// ---------- 附件上传（先传到 R2，发送时再取出） ----------

compose.post("/uploads", async (c) => {
  const filename = decodeURIComponent(c.req.header("X-Filename") ?? "file").slice(0, 200) || "file";
  const type = c.req.header("Content-Type") || "application/octet-stream";
  const len = Number(c.req.header("Content-Length") ?? 0);
  if (len > MAX_UPLOAD) return c.json({ error: `单个附件不能超过 ${MAX_UPLOAD / 1024 / 1024} MB` }, 413);
  const data = await c.req.arrayBuffer();
  if (data.byteLength > MAX_UPLOAD) return c.json({ error: `单个附件不能超过 ${MAX_UPLOAD / 1024 / 1024} MB` }, 413);
  if (!data.byteLength) return c.json({ error: "文件是空的" }, 400);
  const id = randomId(16);
  await blobs(c.env).put(`uploads/${id}`, data, {
    httpMetadata: { contentType: type },
    customMetadata: { filename, created: String(now()), owner: c.get("session").userId },
  });
  return c.json({ id, filename, size: data.byteLength, type });
});

compose.delete("/uploads/:id", async (c) => {
  const key = `uploads/${c.req.param("id")}`;
  const head = await blobs(c.env).head(key);
  if (head && head.customMetadata?.owner && head.customMetadata.owner !== c.get("session").userId) return c.json({ error: "无权删除" }, 403);
  await blobs(c.env).delete(key);
  return c.json({ ok: true });
});

// ---------- 草稿（每个用户只看到自己的） ----------

compose.get("/drafts", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, data, updated_at FROM drafts WHERE owner = ? ORDER BY updated_at DESC LIMIT 200")
    .bind(c.get("session").userId)
    .all<any>();
  return c.json(results.map((r) => ({ id: r.id, updated_at: r.updated_at, ...JSON.parse(r.data) })));
});

compose.get("/drafts/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT id, data, updated_at FROM drafts WHERE id = ? AND owner = ?").bind(c.req.param("id"), c.get("session").userId).first<any>();
  if (!row) return c.json({ error: "草稿不存在" }, 404);
  return c.json({ id: row.id, updated_at: row.updated_at, ...JSON.parse(row.data) });
});

compose.put("/drafts/:id", async (c) => {
  const data = await c.req.json();
  const json = JSON.stringify(data);
  if (json.length > 900_000) return c.json({ error: "草稿内容过大" }, 413);
  const owner = c.get("session").userId;
  const res = await c.env.DB.prepare(
    `INSERT INTO drafts (id, data, updated_at, owner) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE drafts.owner = excluded.owner`,
  ).bind(c.req.param("id"), json, now(), owner).run();
  if (!res.meta.changes) return c.json({ error: "无权修改这份草稿" }, 403);
  return c.json({ ok: true, updated_at: now() });
});

async function deleteDraft(env: Env, id: string, owner: string, keepUploads = false) {
  const row = await env.DB.prepare("SELECT data FROM drafts WHERE id = ? AND owner = ?").bind(id, owner).first<{ data: string }>();
  if (!row) return;
  if (!keepUploads) {
    const atts: { uploadId?: string }[] = JSON.parse(row.data).attachments ?? [];
    const drop = atts.map((a) => a.uploadId).filter((u): u is string => Boolean(u));
    if (drop.length) await blobs(env).delete(drop.map((u) => `uploads/${u}`));
  }
  await env.DB.prepare("DELETE FROM drafts WHERE id = ?").bind(id).run();
}

compose.delete("/drafts/:id", async (c) => {
  await deleteDraft(c.env, c.req.param("id"), c.get("session").userId);
  return c.json({ ok: true });
});

// ---------- 联系人补全（按权限范围内的域名） ----------

compose.get("/contacts", async (c) => {
  const s = c.get("session");
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const scopeSql = s.scope.all ? "1=1" : s.scope.domains.length ? `domain IN (${placeholders(s.scope.domains.length)})` : "0";
  const { results } = await c.env.DB.prepare(
    `SELECT address, MAX(name) AS name, SUM(n) AS n, MAX(last_at) AS last FROM contacts
     WHERE ${scopeSql} AND (address LIKE ? OR lower(name) LIKE ?) GROUP BY address ORDER BY n DESC, last DESC LIMIT 8`,
  ).bind(...(s.scope.all ? [] : s.scope.domains), like, like).all<{ address: string; name: string | null }>();
  return c.json(results.map((r) => ({ address: r.address, name: r.name })));
});

// ---------- 发件身份（显示名 + 签名） ----------

compose.get("/identities", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT address, name, signature, updated_at FROM identities ORDER BY address").all<any>();
  const s = c.get("session");
  return c.json(s.scope.all ? results : results.filter((i) => i.address === "*" || canUseAddress(s.scope, i.address.startsWith("@") ? "x" + i.address : i.address)));
});

compose.put("/identities", async (c) => {
  const s = c.get("session");
  const { address, name, signature } = await c.req.json<{ address: string; name?: string; signature?: string }>();
  const key = address.trim().toLowerCase();
  if (!(key === "*" || /^@[^\s@]+\.[^\s@]+$/.test(key) || isEmail(key))) {
    return c.json({ error: "请填写完整地址（如 hi@a.com）、@域名（如 @a.com）或 *（全局默认）" }, 400);
  }
  if (s.role !== "admin" && !(isEmail(key) && canUseAddress(s.scope, key))) return c.json({ error: "成员只能设置自己有权限的地址" }, 403);
  if ((signature ?? "").length > 20000) return c.json({ error: "签名过长" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO identities (address, name, signature, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET name = excluded.name, signature = excluded.signature, updated_at = excluded.updated_at`,
  ).bind(key, name?.trim() || null, signature || null, now()).run();
  return c.json({ ok: true });
});

compose.delete("/identities/:address", async (c) => {
  const s = c.get("session");
  const key = decodeURIComponent(c.req.param("address"));
  if (s.role !== "admin" && !(isEmail(key) && canUseAddress(s.scope, key))) return c.json({ error: "无权删除" }, 403);
  await c.env.DB.prepare("DELETE FROM identities WHERE address = ?").bind(key).run();
  return c.json({ ok: true });
});

// ---------- 模板 ----------

compose.get("/templates", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM templates ORDER BY name").all();
  return c.json(results);
});

compose.put("/templates/:id", async (c) => {
  const { name, subject, html } = await c.req.json<{ name: string; subject?: string; html: string }>();
  if (!name?.trim()) return c.json({ error: "请填写模板名称" }, 400);
  if ((html ?? "").length > 200000) return c.json({ error: "模板内容过长" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO templates (id, name, subject, html, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, subject = excluded.subject, html = excluded.html, updated_at = excluded.updated_at",
  ).bind(c.req.param("id"), name.trim(), subject ?? null, html ?? "", now()).run();
  return c.json({ ok: true });
});

compose.delete("/templates/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---------- 发送 ----------

type AttachmentRef = { uploadId: string } | { messageId: string; index: number };

export interface SendRequest {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyToId?: string;
  attachments?: AttachmentRef[];
  draftId?: string;
  sendAt?: number; // 定时发送（秒级时间戳）
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// References 头不能超过 2048 字节：保留第一封和最近的若干封
function buildReferences(ids: string[]): string {
  let list = [...new Set(ids)];
  while (list.join(" ").length > 1900 && list.length > 2) list = [list[0], ...list.slice(2)];
  return list.join(" ");
}

async function attachmentSize(env: Env, ref: AttachmentRef): Promise<number> {
  if ("uploadId" in ref) return (await blobs(env).head(`uploads/${ref.uploadId}`))?.size ?? 0;
  const bodyObj = await blobs(env).get(`msg/${ref.messageId}/body.json`);
  const body = bodyObj ? await bodyObj.json<StoredBody>() : null;
  return body?.attachments[ref.index]?.size ?? 0;
}

async function loadAttachment(env: Env, ref: AttachmentRef): Promise<SentAttachment> {
  if ("uploadId" in ref) {
    const obj = await blobs(env).get(`uploads/${ref.uploadId}`);
    if (!obj) throw new HttpError(410, "附件已过期，请重新添加");
    return { filename: obj.customMetadata?.filename ?? "file", type: obj.httpMetadata?.contentType ?? "application/octet-stream", data: new Uint8Array(await obj.arrayBuffer()) };
  }
  const bodyObj = await blobs(env).get(`msg/${ref.messageId}/body.json`);
  const body = bodyObj ? await bodyObj.json<StoredBody>() : null;
  const att = body?.attachments[ref.index];
  const obj = att && (await blobs(env).get(att.key));
  if (!att || !obj) throw new HttpError(410, "原邮件的附件不存在");
  return { filename: att.filename, type: att.mimeType, data: new Uint8Array(await obj.arrayBuffer()) };
}

export function validateSend(req: SendRequest, scope: Scope) {
  const from = req.from?.trim().toLowerCase();
  const clean = (xs?: string[]) => [...new Set((xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const to = clean(req.to);
  const cc = clean(req.cc);
  const bcc = clean(req.bcc);
  if (!from || !isEmail(from)) throw new HttpError(400, "发件地址无效");
  if (!canUseAddress(scope, from)) throw new HttpError(403, "你没有使用这个发件地址的权限");
  const bad = [...to, ...cc, ...bcc].find((x) => !isEmail(x));
  if (bad) throw new HttpError(400, `收件地址无效：${bad}`);
  if (!to.length && !cc.length && !bcc.length) throw new HttpError(400, "请填写收件人");
  if (to.length + cc.length + bcc.length > 50) throw new HttpError(400, "收件人合计不能超过 50 个");
  return { from, to, cc, bcc };
}

// 真正的发送逻辑：接口和定时任务共用
const PROVIDER_NAME: Record<Provider, string> = { cloudflare: "Cloudflare", resend: "Resend", none: "" };

export async function performSend(
  env: Env,
  req: SendRequest,
  scope: Scope,
  owner: string,
): Promise<{ id: string | null; threadId: string | null; warning?: string; via?: string }> {
  const { from, to, cc, bcc } = validateSend(req, scope);
  const domain = await env.DB.prepare("SELECT send_provider, fallback_provider, fallback_status FROM domains WHERE name = ?")
    .bind(domainOf(from))
    .first<{ send_provider: Provider; fallback_provider: Provider | null; fallback_status: string | null }>();
  if (!domain) throw new HttpError(400, `${domainOf(from)} 不是本邮箱已配置的域名`);
  // 发件顺序：主服务 → 备用服务（已开通且不是失败状态）
  const chain: Provider[] = [];
  if (domain.send_provider !== "none") chain.push(domain.send_provider);
  if (domain.fallback_provider && domain.fallback_provider !== domain.send_provider && domain.fallback_status && domain.fallback_status !== "error") {
    chain.push(domain.fallback_provider);
  }
  if (!chain.length) throw new HttpError(400, "这个域名还没有开通发件服务");

  // 先只看大小（不把文件读进内存）；超过主服务上限时直接用上限更大的备用服务
  const refs = (req.attachments ?? []).slice(0, 32);
  const sizes = await Promise.all(refs.map((r) => attachmentSize(env, r)));
  const total = encodedSize(sizes.reduce((a, b) => a + b, 0)) + (req.text?.length ?? 0) + (req.html?.length ?? 0);
  const usable = chain.filter((p) => total <= LIMITS[p]);
  if (!usable.length) {
    const limit = Math.max(...chain.map((p) => LIMITS[p]));
    throw new HttpError(413, `邮件过大（编码后约 ${(total / 1048576).toFixed(1)} MB），当前发件服务上限 ${limit / 1048576} MB`);
  }
  const attachments = await Promise.all(refs.map((r) => loadAttachment(env, r)));

  const headers: Record<string, string> = {};
  let inReplyTo: string | null = null;
  let refsHdr: string | null = null;
  let threadId: string | null = null;
  if (req.replyToId) {
    const orig = await env.DB.prepare("SELECT message_id, in_reply_to, refs, thread_id FROM messages WHERE id = ?")
      .bind(req.replyToId)
      .first<{ message_id: string | null; in_reply_to: string | null; refs: string | null; thread_id: string }>();
    if (orig) {
      threadId = orig.thread_id;
      const chain = [...parseRefs(orig.refs), ...parseRefs(orig.in_reply_to)];
      // 回复自己发出的、没有 Message-ID 的邮件时，沿用它引用的那一串
      const target = orig.message_id ?? chain[chain.length - 1] ?? null;
      if (target) {
        inReplyTo = target;
        refsHdr = buildReferences([...chain, ...(orig.message_id ? [orig.message_id] : [])]);
        headers["In-Reply-To"] = inReplyTo;
        headers["References"] = refsHdr;
      }
    }
  }

  const outgoing: Outgoing = {
    from: { email: from, name: req.fromName?.trim() || undefined },
    to,
    cc,
    bcc,
    subject: req.subject ?? "",
    text: req.text ?? "",
    html: req.html || undefined,
    headers,
    attachments: attachments.map((a) => ({ filename: a.filename, type: a.type, content: b64encode(a.data) })),
    idempotencyKey: req.draftId ? `draft-${req.draftId}` : undefined,
  };
  let provider: Provider = usable[0];
  let providerMessageId: string | null = null;
  let via: string | undefined;
  for (let i = 0; i < usable.length; i++) {
    provider = usable[i];
    try {
      providerMessageId = await sendVia(env, provider, outgoing);
      break;
    } catch (e) {
      const next = usable[i + 1];
      if (!next || !(e instanceof SendError) || !e.failover) {
        // 备用也失败了：把主服务的失败原因一起带上，方便排查
        if (i > 0 && e instanceof SendError) throw new SendError(`${via}；备用 ${e.message}`, e.code);
        throw e;
      }
      console.warn(`send failover ${provider} → ${next}`, e.code, e.message);
      via = e.message;
    }
  }
  if (provider !== chain[0]) {
    via = via
      ? `${PROVIDER_NAME[chain[0]]} 暂时无法发送，已通过备用的 ${PROVIDER_NAME[provider]} 发出`
      : `邮件超过 ${PROVIDER_NAME[chain[0]]} 的大小上限，已通过备用的 ${PROVIDER_NAME[provider]} 发出`;
  } else via = undefined;

  // 已经发出去了：后面任何失败都不能让用户以为没发（否则重发会导致对方收到两封）
  let stored: { id: string; threadId: string } | null = null;
  let warning: string | undefined;
  try {
    stored = await storeSent(env, {
      from: outgoing.from,
      to,
      cc,
      bcc,
      subject: outgoing.subject,
      text: outgoing.text,
      html: outgoing.html,
      inReplyTo,
      refs: refsHdr,
      threadId,
      provider,
      providerMessageId,
      messageId: null,
      attachments,
    });
  } catch (e: any) {
    console.error("storeSent failed", e);
    warning = "邮件已发出，但保存到「已发送」时出错";
  }
  const uploadIds = refs.flatMap((r) => ("uploadId" in r ? [r.uploadId] : []));
  if (uploadIds.length) await blobs(env).delete(uploadIds.map((u) => `uploads/${u}`)).catch(() => {});
  if (req.draftId) await env.DB.prepare("DELETE FROM drafts WHERE id = ? AND owner = ?").bind(req.draftId, owner).run().catch(() => {});
  return { id: stored?.id ?? null, threadId: stored?.threadId ?? threadId, warning, via };
}

compose.post("/send", async (c) => {
  const s = c.get("session");
  const req = await c.req.json<SendRequest>();
  try {
    if (req.sendAt && req.sendAt > now() + 30) {
      validateSend(req, s.scope);
      if (req.sendAt > now() + 366 * 86400) throw new HttpError(400, "定时发送最多提前一年");
      const id = randomId(12);
      await c.env.DB.prepare("INSERT INTO scheduled (id, owner, payload, send_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, s.userId, JSON.stringify(req), Math.floor(req.sendAt), now())
        .run();
      if (req.draftId) await c.env.DB.prepare("DELETE FROM drafts WHERE id = ? AND owner = ?").bind(req.draftId, s.userId).run();
      return c.json({ ok: true, scheduled: id, sendAt: Math.floor(req.sendAt) });
    }
    return c.json({ ok: true, ...(await performSend(c.env, req, s.scope, s.userId)) });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400);
    throw e;
  }
});

compose.get("/scheduled", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, payload, send_at, status, error, created_at FROM scheduled WHERE owner = ? AND status != 'sent' ORDER BY send_at")
    .bind(c.get("session").userId)
    .all<any>();
  return c.json(results.map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
});

// 取消定时发送：返回原内容，前端可以重新打开编辑
compose.delete("/scheduled/:id", async (c) => {
  const row = await c.env.DB.prepare("DELETE FROM scheduled WHERE id = ? AND owner = ? AND status IN ('pending', 'failed') RETURNING payload")
    .bind(c.req.param("id"), c.get("session").userId)
    .first<{ payload: string }>();
  if (!row) return c.json({ error: "已经发出或不存在" }, 404);
  return c.json({ ok: true, payload: JSON.parse(row.payload) });
});

// 定时任务调用：发送到期的邮件
export async function runScheduled(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "UPDATE scheduled SET status = 'sending' WHERE id IN (SELECT id FROM scheduled WHERE status = 'pending' AND send_at <= ? LIMIT 20) RETURNING id, owner, payload",
  ).bind(now()).all<{ id: string; owner: string; payload: string }>();
  for (const r of results) {
    let scope: Scope = FULL;
    if (r.owner.startsWith("member:")) {
      const m = await env.DB.prepare("SELECT scope, disabled FROM members WHERE id = ?").bind(r.owner.slice(7)).first<{ scope: string; disabled: number }>();
      scope = m && !m.disabled ? parseScope(m.scope) : { all: false, domains: [], addresses: [] };
    }
    try {
      await performSend(env, JSON.parse(r.payload), scope, r.owner);
      await env.DB.prepare("UPDATE scheduled SET status = 'sent' WHERE id = ?").bind(r.id).run();
    } catch (e: any) {
      await env.DB.prepare("UPDATE scheduled SET status = 'failed', error = ? WHERE id = ?").bind(String(e?.message ?? e).slice(0, 300), r.id).run();
    }
  }
  // 发出超过 7 天的记录清掉
  await env.DB.prepare("DELETE FROM scheduled WHERE status = 'sent' AND send_at < ?").bind(now() - 7 * 86400).run();
}
