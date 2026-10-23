// 接口测试：收信、去重、会话归类、计数、整理操作、发送、定时发送、导入、安全相关的修复
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { BASE, Client, cron, deliver, mail, MOCK, sleep, sql } from "./helpers.mjs";

const c = new Client();
const HR = "hr@example.com";
const SALES = "sales@example.com";

const threads = (q = "view=inbox") => c.api(`/threads?${q}`).then((r) => r.threads);
const findThread = async (subject, q) => (await threads(q)).find((t) => t.subject === subject);
const stats = () => c.api("/stats");
const recount = () =>
  sql(`SELECT s.mailbox, s.total, s.unread,
    (SELECT COUNT(*) FROM messages m WHERE m.mailbox = s.mailbox AND m.deleted_at IS NULL) AS real_total,
    (SELECT COUNT(*) FROM messages m WHERE m.mailbox = s.mailbox AND m.deleted_at IS NULL AND folder = 'inbox' AND is_read = 0 AND archived = 0 AND spam = 0 AND COALESCE(parse_error,'') != 'pending') AS real_unread
    FROM mailbox_stats s WHERE s.total != real_total OR s.unread != real_unread`);

before(async () => {
  const now = Math.floor(Date.now() / 1000);
  sql(`INSERT OR IGNORE INTO domains (name, zone_id, account_id, receive_status, send_provider, send_status, created_at, updated_at) VALUES
    ('example.com', 'z1', 'a1', 'active', 'resend', 'active', ${now}, ${now}),
    ('other.test', 'z2', 'a1', 'active', 'none', 'none', ${now}, ${now})`);
  await c.login();
  await c.api("/settings", { method: "PUT", body: { resendApiKey: "re_test_key" } });
});

describe("收信", () => {
  test("带附件的邮件入库，解析完成", async () => {
    await deliver(mail({ to: HR, subject: "附件测试", attachments: [{ name: "a.bin", data: Buffer.alloc(3000, 7) }, { name: "b.txt", type: "text/plain", data: "hello" }] }), HR);
    const t = await findThread("附件测试");
    assert.ok(t, "收件箱里有这封邮件");
    const d = await c.api(`/threads/${t.thread_id}`);
    assert.equal(d.messages.length, 1);
    assert.equal(d.messages[0].parse_error, null);
    assert.equal(d.messages[0].attachments.length, 2);
    const att = await c.req(`/api/messages/${d.messages[0].id}/attachments/0`);
    assert.equal(att.status, 200);
  });

  test("重复投递只保存一份", async () => {
    const m = mail({ to: HR, subject: "重复投递" });
    await deliver(m, HR);
    await deliver(m, HR);
    const rows = sql(`SELECT COUNT(*) AS n FROM messages WHERE message_id = '${m.messageId}'`);
    assert.equal(rows[0].n, 1);
  });

  test("中断在 pending 的邮件：重投时继续处理；超时的由定时任务收尾", async () => {
    const m = mail({ to: HR, subject: "中断续传", text: "续传正文" });
    await deliver(m, HR);
    sql(`UPDATE messages SET parse_error = 'pending', snippet = '' WHERE message_id = '${m.messageId}'`);
    await deliver(m, HR);
    let row = sql(`SELECT parse_error, snippet FROM messages WHERE message_id = '${m.messageId}'`)[0];
    assert.equal(row.parse_error, null);
    assert.match(row.snippet, /续传正文/);
    sql(`UPDATE messages SET parse_error = 'pending', created_at = created_at - 600 WHERE message_id = '${m.messageId}'`);
    await cron();
    row = sql(`SELECT parse_error FROM messages WHERE message_id = '${m.messageId}'`)[0];
    assert.equal(row.parse_error, "timeout");
    const ev = sql("SELECT kind FROM events WHERE kind = 'inbound_timeout'");
    assert.ok(ev.length >= 1, "记录了系统事件");
  });

  test("回复按 In-Reply-To 归到同一会话；外部不能把邮件塞进别的地址的会话", async () => {
    const first = mail({ to: HR, subject: "归类测试" });
    await deliver(first, HR);
    await deliver(mail({ to: HR, subject: "Re: 归类测试", inReplyTo: first.messageId }), HR);
    await deliver(mail({ to: SALES, subject: "Re: 归类测试", inReplyTo: first.messageId, from: "mallory@evil.test" }), SALES, "mallory@evil.test");
    const rows = sql(`SELECT mailbox, thread_id FROM messages WHERE subject LIKE '%归类测试'`);
    const hr = rows.filter((r) => r.mailbox === HR);
    const sales = rows.find((r) => r.mailbox === SALES);
    assert.equal(hr.length, 2);
    assert.equal(hr[0].thread_id, hr[1].thread_id);
    assert.notEqual(sales.thread_id, hr[0].thread_id);
  });

  test("各语言的回复前缀（AW: / RE[2]: / 回复：）按主题归类", async () => {
    const first = mail({ to: HR, subject: "Rechnung 42", from: "bob@sender.test" });
    await deliver(first, HR, "bob@sender.test");
    await deliver(mail({ to: HR, subject: "AW: Rechnung 42", from: "bob@sender.test" }), HR, "bob@sender.test");
    const rows = sql(`SELECT DISTINCT thread_id FROM messages WHERE subject LIKE '%Rechnung 42'`);
    assert.equal(rows.length, 1);
  });
});

describe("计数（触发器维护）", () => {
  test("标为已读 / 未读、删除、恢复后计数正确", async () => {
    await deliver(mail({ to: HR, subject: "计数测试" }), HR);
    const t = await findThread("计数测试");
    const s0 = await stats();
    await c.api("/threads/action", { body: { threadIds: [t.thread_id], action: "read" } });
    assert.equal((await stats()).unread, s0.unread - 1);
    await c.api("/threads/action", { body: { threadIds: [t.thread_id], action: "unread" } });
    assert.equal((await stats()).unread, s0.unread);
    await c.api("/threads/action", { body: { threadIds: [t.thread_id], action: "trash" } });
    assert.equal((await stats()).unread, s0.unread - 1);
    await c.api("/threads/action", { body: { threadIds: [t.thread_id], action: "restore" } });
    assert.equal((await stats()).unread, s0.unread);
    const poll = await c.api("/poll");
    assert.equal(poll.unread, s0.unread);
    assert.ok(poll.latestInboxAt > 0);
    assert.deepEqual(recount(), [], "地址计数和实际一致");
  });
});

describe("整理操作", () => {
  test("稍后提醒的会话收到新回复后回到收件箱", async () => {
    const first = mail({ to: HR, subject: "提醒测试" });
    await deliver(first, HR);
    const t = await findThread("提醒测试");
    await c.api("/threads/action", { body: { threadIds: [t.thread_id], action: "snooze", until: Math.floor(Date.now() / 1000) + 86400 } });
    assert.equal(await findThread("提醒测试"), undefined, "提醒期间不在收件箱");
    await deliver(mail({ to: HR, subject: "Re: 提醒测试", inReplyTo: first.messageId }), HR);
    assert.ok(await findThread("提醒测试"), "新回复到达后回到收件箱");
  });

  test("垃圾邮件视图的永久删除只删垃圾邮件，正常邮件保留", async () => {
    const first = mail({ to: HR, subject: "混合会话" });
    await deliver(first, HR);
    await deliver(mail({ to: HR, subject: "Re: 混合会话", inReplyTo: first.messageId, text: "这封是垃圾" }), HR);
    const t = await findThread("混合会话");
    const d = await c.api(`/threads/${t.thread_id}`);
    const spamMsg = d.messages.find((m) => m.snippet?.includes("这封是垃圾"));
    await c.api(`/messages/${spamMsg.id}/action`, { body: { action: "spam" } });
    await c.api("/threads/action", { body: { threadIds: [t.thread_id], action: "purge_spam" } });
    const left = sql(`SELECT id, spam FROM messages WHERE thread_id = '${t.thread_id}'`);
    assert.equal(left.length, 1, "正常邮件还在");
    assert.equal(left[0].spam, 0);
  });

  test("过期的废纸篓邮件由每分钟的清理任务删除（文件一并删除）", async () => {
    await deliver(mail({ to: HR, subject: "过期测试", attachments: [{ name: "x.bin", data: Buffer.alloc(100, 1) }] }), HR);
    const t = await findThread("过期测试");
    await c.api("/threads/action", { body: { threadIds: [t.thread_id], action: "trash" } });
    sql(`UPDATE messages SET deleted_at = deleted_at - 40 * 86400 WHERE thread_id = '${t.thread_id}'`);
    await cron();
    assert.equal(sql(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = '${t.thread_id}'`)[0].n, 0);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM threads WHERE thread_id = '${t.thread_id}'`)[0].n, 0, "会话汇总也删除了");
  });
});

describe("发送", () => {
  test("通过 Resend 发出的邮件保存实际的 Message-ID，对方回复归到同一会话", async () => {
    const r = await c.api("/send", { body: { from: SALES, to: ["carol@client.test"], subject: "报价单", text: "请查收", html: "<p>请查收</p>" } });
    assert.ok(r.id);
    const sent = await fetch(`${MOCK}/__sent`).then((x) => x.json());
    const last = sent[sent.length - 1];
    assert.match(last.headers["Message-ID"], /^<.+@example\.com>$/, "带上了自己生成的 Message-ID");
    const row = sql(`SELECT message_id, thread_id FROM messages WHERE id = '${r.id}'`)[0];
    assert.equal(row.message_id, last.messageId);
    await deliver(mail({ to: SALES, from: "carol@client.test", subject: "Antw: 报价单", inReplyTo: last.messageId }), SALES, "carol@client.test");
    const reply = sql(`SELECT thread_id FROM messages WHERE subject = 'Antw: 报价单'`)[0];
    assert.equal(reply.thread_id, row.thread_id);
  });

  test("定时发送：到期发出；卡在发送中的改为失败，可以重试", async () => {
    const r = await c.api("/send", { body: { from: SALES, to: ["dave@client.test"], subject: "定时", text: "x", sendAt: Math.floor(Date.now() / 1000) + 3600 } });
    sql(`UPDATE scheduled SET send_at = send_at - 7200 WHERE id = '${r.scheduled}'`);
    await cron();
    assert.equal(sql(`SELECT status FROM scheduled WHERE id = '${r.scheduled}'`)[0].status, "sent");

    const r2 = await c.api("/send", { body: { from: SALES, to: ["dave@client.test"], subject: "卡住", text: "x", sendAt: Math.floor(Date.now() / 1000) + 3600 } });
    sql(`UPDATE scheduled SET status = 'sending', claimed_at = ${Math.floor(Date.now() / 1000) - 3600} WHERE id = '${r2.scheduled}'`);
    await cron();
    assert.equal(sql(`SELECT status FROM scheduled WHERE id = '${r2.scheduled}'`)[0].status, "failed");
    await c.api(`/scheduled/${r2.scheduled}/retry`, { body: {} });
    await cron();
    assert.equal(sql(`SELECT status FROM scheduled WHERE id = '${r2.scheduled}'`)[0].status, "sent");
  });

  test("双重提交同一草稿不会重复发送（幂等键）", async () => {
    const body = { from: SALES, to: ["erin@client.test"], subject: "幂等", text: "x", draftId: "draft-idem-1" };
    await c.api("/send", { body });
    const sent = await fetch(`${MOCK}/__sent`).then((x) => x.json());
    assert.equal(sent.filter((s) => s.subject === "幂等").length, 1);
  });
});

describe("安全", () => {
  test("邮件正文的 CSP 不允许加载任意站内地址", async () => {
    await deliver(mail({ to: HR, subject: "CSP 测试" }), HR);
    const t = await findThread("CSP 测试");
    const d = await c.api(`/threads/${t.thread_id}`);
    const r = await c.req(`/api/messages/${d.messages[0].id}/html`);
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /img-src data: http:\/\/127\.0\.0\.1:\d+\/api\/img /);
    assert.doesNotMatch(csp, /img-src[^;]*'self'/);
  });

  test("登录链接：打开只显示确认页，不会直接登录", async () => {
    const r = await fetch(`${BASE}/auth/magic/not-a-real-token`, { redirect: "manual" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null);
    assert.match(await r.text(), /<form method="post">/);
    const p = await fetch(`${BASE}/auth/magic/not-a-real-token`, { method: "POST", redirect: "manual" });
    assert.equal(p.status, 400);
  });

  test("一键退订：mailto 只能是单个合法地址", async () => {
    await deliver(mail({ to: HR, subject: "退订测试 1", headers: { "List-Unsubscribe": "<mailto:a@x.test,boss@corp.test?subject=hi>" } }), HR);
    await deliver(mail({ to: SALES, subject: "退订测试 2", headers: { "List-Unsubscribe": "<mailto:unsub@list.test?subject=remove%0D%0ABcc:%20x@y.test>" } }), SALES);
    const bad = await findThread("退订测试 1");
    const d1 = await c.api(`/threads/${bad.thread_id}`);
    const r1 = await c.req(`/api/messages/${d1.messages[0].id}/unsubscribe`, { body: {} });
    assert.equal(r1.status, 400, "多个收件人的 mailto 被拒绝");
    const ok = await findThread("退订测试 2");
    const d2 = await c.api(`/threads/${ok.thread_id}`);
    const r2 = await c.api(`/messages/${d2.messages[0].id}/unsubscribe`, { body: {} });
    assert.equal(r2.to, "unsub@list.test");
    const sent = await fetch(`${MOCK}/__sent`).then((x) => x.json());
    const e = sent.find((s) => s.to?.[0] === "unsub@list.test");
    assert.ok(e && !/[\r\n]/.test(e.subject), "主题里的换行被去掉");
  });

  test("团队成员不能引用权限以外的邮件附件", async () => {
    await deliver(mail({ to: SALES, subject: "销售机密", attachments: [{ name: "secret.pdf", type: "application/pdf", data: "%PDF-1.4 secret" }] }), SALES);
    const secret = sql(`SELECT id FROM messages WHERE subject = '销售机密'`)[0];
    const mid = "member-test-1";
    await c.api(`/members/${mid}`, { method: "PUT", body: { email: "m1@example.com", name: "M1", scope: { all: false, domains: [], addresses: [HR] } } });
    const token = "membertoken0123456789abcdefghijklmnop";
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
    sql(`INSERT INTO login_tokens (hash, member_id, expires_at) VALUES ('${hash}', '${mid}', ${Math.floor(Date.now() / 1000) + 600})`);
    const login = await fetch(`${BASE}/auth/magic/${token}`, { method: "POST", redirect: "manual" });
    const m = new Client();
    m.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.ok(m.cookie, "成员登录成功");
    const list = await m.api("/threads?view=all");
    assert.ok(!list.threads.some((t) => t.subject === "销售机密"), "看不到范围外的会话");
    const r = await m.req("/api/send", { body: { from: HR, to: ["leak@evil.test"], subject: "x", text: "x", attachments: [{ messageId: secret.id, index: 0 }] } });
    assert.equal(r.status, 403);
  });

  test("密码登录：同一个 IP 连续失败后限流", async () => {
    await c.api("/account/password", { method: "PUT", body: { next: "correct-horse-battery" } });
    sql("DELETE FROM auth_attempts");
    let last;
    for (let i = 0; i < 11; i++) last = await fetch(`${BASE}/auth/password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong-password-" + i }) });
    assert.equal(last.status, 429);
    sql("DELETE FROM auth_attempts");
  });
});

describe("导入", () => {
  test("按发件人 / 收件人归类，重复导入跳过", async () => {
    const inbound = mail({ to: HR, subject: "导入的收件", date: "Mon, 05 Jan 2026 08:00:00 +0000" });
    const sentMail = mail({ from: SALES, fromName: "Sales", to: "zed@client.test", subject: "导入的发件" });
    const nowhere = mail({ to: "someone@elsewhere.test", subject: "无法归类" });
    const imp = (m, q = "") => c.req(`/api/import${q}`, { raw: m.raw, headers: { "Content-Type": "message/rfc822" } });
    const r1 = await imp(inbound);
    assert.equal(r1.data.folder, "inbox");
    assert.equal(r1.data.mailbox, HR);
    const r2 = await imp(sentMail);
    assert.equal(r2.data.folder, "sent");
    assert.equal((await imp(nowhere)).status, 422);
    assert.equal((await imp(nowhere, `?mailbox=${HR}`)).data.status, "stored");
    assert.equal((await imp(inbound)).data.status, "duplicate");
    const row = sql(`SELECT created_at, is_read FROM messages WHERE subject = '导入的收件'`)[0];
    assert.equal(row.created_at, Math.floor(Date.parse("2026-01-05T08:00:00Z") / 1000), "使用信头里的日期");
    assert.equal(row.is_read, 1);
  });
});

describe("添加域名", () => {
  const cfState = () => fetch(`${MOCK}/cf/__state`).then((r) => r.json());

  test("有第三方 MX 时先征得同意；同意后删掉旧 MX 再开启 Email Routing", async () => {
    sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('account_id', 'a1')");
    const first = await c.api("/domains", { body: { zoneId: "z-mx" } });
    assert.equal(first.ok, false);
    assert.equal(first.conflict.mx[0].content, "aspmx.l.google.com");
    const r = await c.api("/domains", { body: { zoneId: "z-mx", replaceMx: true } });
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    const z = (await cfState())["z-mx"];
    assert.equal(z.routing, true);
    assert.ok(!z.dns.some((x) => x.content === "aspmx.l.google.com"), "旧 MX 已删除");
    assert.ok(z.dns.some((x) => /mx\.cloudflare\.net$/.test(x.content)), "Cloudflare 的 MX 已添加");
    assert.equal(z.catchAll.actions[0].type, "worker");
    assert.ok(sql("SELECT value FROM settings WHERE key = 'mx_backup:z-mx'")[0].value.includes("aspmx.l.google.com"), "旧 MX 已备份");
    assert.equal(sql("SELECT receive_status FROM domains WHERE name = 'mx.test'")[0].receive_status, "active");
  });

  test("删掉旧 MX 后仍然开启失败：把旧 MX 恢复回去", async () => {
    const r = await c.api("/domains", { body: { zoneId: "z-fail", replaceMx: true } });
    assert.equal(r.ok, false);
    assert.match(r.steps.at(-1).detail, /已把删除的 MX 记录恢复回去/);
    const z = (await cfState())["z-fail"];
    assert.ok(z.dns.some((x) => x.content === "aspmx.l.google.com"), "旧 MX 还在");
    assert.equal(sql("SELECT COUNT(*) AS n FROM domains WHERE name = 'fail.test'")[0].n, 0);
  });
});

describe("系统状态", () => {
  test("状态和提醒接口可用", async () => {
    const st = await c.api("/system/status");
    assert.match(st.version.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Array.isArray(st.events));
    assert.ok(st.usage.error, "没有令牌时给出说明而不是报错");
    const a = await c.api("/system/alerts");
    assert.ok(a.alerts.some((x) => x.key.startsWith("inbound:")), "收信异常会提醒");
  });

  test("最后：所有地址的计数和实际一致", async () => {
    await sleep(200);
    assert.deepEqual(recount(), []);
    const total = sql("SELECT unread FROM stats_total")[0].unread;
    const sum = sql("SELECT COALESCE(SUM(unread), 0) AS n FROM mailbox_stats")[0].n;
    assert.equal(total, sum);
  });
});
