// 定时任务：每分钟（定时发送、稍后提醒到期、投递状态、数据回填）+ 每天（清理）
import { ownerCf, purgeExpiredSessions } from "./auth";
import type { Env } from "./env";
import { purgeMessages } from "./mail";
import { runScheduled } from "./routes/compose";
import { refreshPendingSending } from "./provision";
import { refreshDelivery } from "./routes/org";
import { backfillPending, backfillStep, touch } from "./threads";
import { getSetting, now, placeholders, setSetting } from "./util";
import { blobs } from "./storage";

export async function everyMinute(env: Env): Promise<void> {
  await runScheduled(env).catch((e) => console.error("scheduled send", e));
  await wakeSnoozed(env).catch((e) => console.error("snooze", e));
  if (await backfillPending(env)) await backfillStep(env, 200).catch((e) => console.error("backfill", e));

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

export async function daily(env: Env): Promise<void> {
  // 垃圾箱和垃圾邮件超过 30 天的彻底删除
  const cutoff = now() - 30 * 86400;
  const { results } = await env.DB.prepare(
    "SELECT id FROM messages WHERE (deleted_at IS NOT NULL AND deleted_at < ?) OR (spam = 1 AND deleted_at IS NULL AND created_at < ?) LIMIT 300",
  ).bind(cutoff, cutoff).all<{ id: string }>();
  if (results.length) await purgeMessages(env, results.map((r) => r.id));

  // 超过 7 天、且没有被草稿或定时发送引用的临时附件
  const [drafts, scheduled] = await Promise.all([
    env.DB.prepare("SELECT data FROM drafts").all<{ data: string }>(),
    env.DB.prepare("SELECT payload FROM scheduled WHERE status IN ('pending', 'sending', 'failed')").all<{ payload: string }>(),
  ]);
  const referenced = new Set<string>();
  for (const d of drafts.results) for (const a of JSON.parse(d.data).attachments ?? []) if (a.uploadId) referenced.add(a.uploadId);
  for (const s of scheduled.results) for (const a of JSON.parse(s.payload).attachments ?? []) if (a.uploadId) referenced.add(a.uploadId);
  let cursor: string | undefined;
  do {
    const listed = await blobs(env).list({ prefix: "uploads/", cursor });
    const stale = listed.objects.filter((o) => o.uploaded.getTime() < Date.now() - 7 * 86400_000 && !referenced.has(o.key.slice(8))).map((o) => o.key);
    if (stale.length) await blobs(env).delete(stale);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  await purgeExpiredSessions(env);
}
