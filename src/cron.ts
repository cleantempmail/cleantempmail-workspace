// 定时任务：每分钟（定时发送、稍后提醒到期、收尾中断的收信、清理、投递状态、数据回填）+ 每天（临时附件、会话、计数校准）
// 免费版每次调用最多 50 次 D1 查询：每分钟的任务按优先级执行，处理了定时发送的那一分钟跳过较重的维护任务
import { ownerCf, purgeExpiredSessions } from "./auth";
import type { Env } from "./env";
import { finalizeStale, purgeMessages, retryBlobTrash } from "./mail";
import { runScheduled } from "./routes/compose";
import { refreshPendingSending } from "./provision";
import { refreshDelivery } from "./routes/org";
import { backfillPending, backfillStep, reconcileStats, touch } from "./threads";
import { getSetting, now, placeholders, setSetting } from "./util";
import { blobs } from "./storage";

export async function everyMinute(env: Env): Promise<void> {
  const sent = await runScheduled(env).catch((e) => (console.error("scheduled send", e), 0));
  await wakeSnoozed(env).catch((e) => console.error("snooze", e));
  await finalizeStale(env).catch((e) => console.error("finalize", e));
  if (sent) return;

  await purgeExpired(env).catch((e) => console.error("purge", e));
  await retryBlobTrash(env).catch((e) => console.error("blob trash", e));
  if (await backfillPending(env)) await backfillStep(env, 40).catch((e) => console.error("backfill", e));

  // 每 15 分钟查一次投递状态（需要管理员登录过且 OAuth 勾选了 analytics.read）
  const last = Number((await getSetting(env, "delivery_checked_at")) ?? 0);
  if (now() - last > 900) {
    await setSetting(env, "delivery_checked_at", String(now()));
    await refreshPendingSending(env).catch((e) => console.warn("refresh sending", e?.message));
    const owner = await ownerCf(env).catch(() => null);
    if (owner && (owner.scope === undefined || owner.scope.split(/\s+/).includes("analytics.read"))) {
      await refreshDelivery(env, owner.cf).catch((e) => console.warn("delivery refresh", e?.message));
    }
  }
}

// "稍后提醒"到期：回到收件箱顶部并标为未读
async function wakeSnoozed(env: Env): Promise<void> {
  const t = now();
  const { results } = await env.DB.prepare("SELECT thread_id FROM threads WHERE snooze_until IS NOT NULL AND snooze_until <= ? LIMIT 50").bind(t).all<{ thread_id: string }>();
  if (!results.length) return;
  const ids = results.map((r) => r.thread_id);
  await env.DB.batch([
    env.DB.prepare(`UPDATE threads SET snooze_until = NULL, unsnoozed_at = ?, sort_at = ? WHERE thread_id IN (${placeholders(ids.length)})`).bind(t, t, ...ids),
    env.DB.prepare(
      `UPDATE messages SET is_read = 0, archived = 0 WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) rn
         FROM messages WHERE folder = 'inbox' AND deleted_at IS NULL AND thread_id IN (${placeholders(ids.length)})) WHERE rn = 1)`,
    ).bind(...ids),
  ]);
  await touch(env, { threads: ids });
}

// 废纸篓和垃圾邮件超过 30 天的彻底删除：每分钟小批量，catch-all 垃圾邮件多也不会积压
async function purgeExpired(env: Env): Promise<void> {
  const cutoff = now() - 30 * 86400;
  const trash = await env.DB.prepare("SELECT id FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 40").bind(cutoff).all<{ id: string }>();
  let ids = trash.results.map((r) => r.id);
  if (ids.length < 40) {
    const spam = await env.DB.prepare("SELECT id FROM messages WHERE spam = 1 AND deleted_at IS NULL AND created_at < ? LIMIT ?").bind(cutoff, 40 - ids.length).all<{ id: string }>();
    ids = ids.concat(spam.results.map((r) => r.id));
  }
  if (ids.length) await purgeMessages(env, ids);
}

export async function daily(env: Env): Promise<void> {
  // 超过 7 天、且没有被草稿或定时发送引用的临时附件
  const [drafts, scheduled] = await Promise.all([
    env.DB.prepare("SELECT data FROM drafts").all<{ data: string }>(),
    env.DB.prepare("SELECT payload FROM scheduled WHERE status IN ('pending', 'sending', 'failed')").all<{ payload: string }>(),
  ]);
  const referenced = new Set<string>();
  for (const d of drafts.results) for (const a of JSON.parse(d.data).attachments ?? []) if (a.uploadId) referenced.add(a.uploadId);
  for (const s of scheduled.results) for (const a of JSON.parse(s.payload).attachments ?? []) if (a.uploadId) referenced.add(a.uploadId);
  let cursor: string | undefined;
  let rounds = 0;
  do {
    const listed = await blobs(env).list({ prefix: "uploads/", cursor });
    const stale = listed.objects.filter((o) => o.uploaded.getTime() < Date.now() - 7 * 86400_000 && !referenced.has(o.key.slice(8))).map((o) => o.key);
    if (stale.length) await blobs(env).delete(stale);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && ++rounds < 10);

  await purgeExpiredSessions(env);
  // 地址计数由触发器维护，每天全量校准一次
  await reconcileStats(env);
}
