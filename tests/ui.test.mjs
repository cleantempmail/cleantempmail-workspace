// 浏览器测试（Playwright）：列表、阅读、写信、设置里的关键交互，以及英文界面不翻译用户内容
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BASE, deliver, mail, sql } from "./helpers.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const HR = "hr@example.com";
let browser;
let errors = [];

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: opts.locale ?? "zh-CN" });
  await ctx.addInitScript((o) => {
    localStorage.setItem("cfm:undoSeconds", "0");
    if (o.lang) localStorage.setItem("cfm:lang", JSON.stringify(o.lang));
  }, opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/auth/login");
  await page.waitForSelector(".row:not(.skeleton)");
  return page;
}

before(async () => {
  browser = await chromium.launch();
  // 接口测试留下的异常记录会在打开应用时弹出提醒，先清掉，免得挡住按钮
  sql("DELETE FROM events");
  // 足够多的邮件，用来测试列表滚动
  for (let i = 0; i < 45; i++) await deliver(mail({ to: HR, subject: `批量邮件 ${String(i).padStart(2, "0")}`, from: `user${i}@bulk.test` }), HR, `user${i}@bulk.test`);
  await deliver(mail({ to: HR, subject: "长会话", html: "<p>第一封 <b>HTML</b> 邮件</p>" }), HR);
  // 品牌头像：通过 DMARC 验证的显示，验证失败（冒充）的不显示
  await deliver(mail({ to: HR, subject: "GitHub 通知", from: "noreply@github.com", headers: { "Authentication-Results": "mx.cloudflare.net; dkim=pass header.d=github.com; dmarc=pass header.from=github.com; spf=pass" } }), HR, "noreply@github.com");
  await deliver(mail({ to: HR, subject: "冒充的通知", from: "service@paypal.com", headers: { "Authentication-Results": "mx.cloudflare.net; dkim=none; dmarc=none header.from=paypal.com; spf=fail" } }), HR, "service@paypal.com");
});

after(async () => {
  await browser?.close();
  assert.deepEqual(errors, [], "页面没有脚本错误");
});

describe("列表与阅读", () => {
  test("打开邮件后列表保持滚动位置", async () => {
    const page = await open();
    const body = page.locator(".list-body");
    await body.evaluate((el) => (el.scrollTop = 600));
    await page.waitForTimeout(300);
    // 点当前可见区域里的一行（同一秒投递的邮件排序不固定，不按主题找）
    const before = await body.evaluate((el) => el.scrollTop);
    const idx = await body.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      return [...el.querySelectorAll(".row")].findIndex((r) => r.getBoundingClientRect().top > top + 40);
    });
    assert.ok(before > 300 && idx > 0, `列表可以滚动（${before}，${idx}）`);
    await body.locator(".row").nth(idx).click();
    await page.waitForSelector(".reader-pane .thread-subject");
    const top = await body.evaluate((el) => el.scrollTop);
    assert.ok(top > 300, `滚动位置保留（${top}）`);
    await page.context().close();
  });

  test("点星标不会重新加载正文", async () => {
    const page = await open();
    await page.locator(".row", { hasText: "长会话" }).click();
    await page.waitForSelector(".reader-pane iframe");
    await page.evaluate(() => (document.querySelector(".reader-pane iframe").dataset.mark = "same"));
    await page.click(".reader-toolbar .star-btn");
    await page.waitForSelector(".reader-toolbar .star-btn.on");
    assert.equal(await page.evaluate(() => document.querySelector(".reader-pane iframe")?.dataset.mark), "same");
    await page.context().close();
  });

  test("品牌头像只给通过验证的发件人", async () => {
    const page = await open();
    assert.equal(await page.locator(".row", { hasText: "GitHub 通知" }).locator("img.av-img").count(), 1);
    assert.equal(await page.locator(".row", { hasText: "冒充的通知" }).locator("img.av-img").count(), 0);
    await page.context().close();
  });

  test("焦点在侧栏链接上按回车，打开的是链接，不是第一封邮件", async () => {
    const page = await open();
    await page.focus('.sidebar a[href="#/sent"]');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash.startsWith("#/sent"));
    assert.equal(await page.evaluate(() => location.hash), "#/sent");
    await page.context().close();
  });
});

describe("写信", () => {
  test("双击发送只发出一封", async () => {
    const page = await open();
    let sends = 0;
    await page.route("**/api/send", (route) => {
      sends++;
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, id: "x", threadId: null }) });
    });
    await page.keyboard.press("c");
    await page.waitForSelector(".composer.show");
    await page.fill(".composer [data-field=to] .rcpt-input", "x@client.test");
    await page.keyboard.press("Enter");
    await page.fill(".composer .subject", "双击测试");
    await page.locator(".composer .send-btn").dblclick();
    await page.waitForTimeout(1500);
    assert.equal(sends, 1);
    await page.context().close();
  });
});

describe("设置", () => {
  test("保存失败时不提示已保存，选项恢复原样", async () => {
    const page = await open();
    await page.goto(BASE + "/#/settings/general");
    await page.waitForSelector("[data-seg=images]");
    await page.route("**/api/settings", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"模拟失败"}' }) : route.continue()));
    const before = await page.locator("[data-seg=images] button.on").getAttribute("data-v");
    await page.click(`[data-seg=images] button:not(.on)`);
    await page.waitForSelector(".toast", { hasText: "模拟失败" });
    assert.equal(await page.locator(".toast", { hasText: "已保存" }).count(), 0);
    assert.equal(await page.locator("[data-seg=images] button.on").getAttribute("data-v"), before);
    await page.context().close();
  });

  test("系统状态页可以打开", async () => {
    const page = await open();
    await page.goto(BASE + "/#/settings/system");
    await page.waitForSelector(".set-card", { hasText: "今日用量" });
    await page.context().close();
  });

  test("导入 mbox 文件", async () => {
    const page = await open();
    await page.goto(BASE + "/#/settings/data");
    await page.waitForSelector("[data-import-files]");
    const one = mail({ to: HR, subject: "从 mbox 导入 1" }).raw.replace(/\r\n/g, "\n");
    const two = mail({ to: HR, subject: "从 mbox 导入 2" }).raw.replace(/\r\n/g, "\n");
    const mbox = `From a@b Mon Jan  5 08:00:00 2026\n${one}\nFrom a@b Mon Jan  5 09:00:00 2026\n${two}\n`;
    await page.setInputFiles("[data-import-files]", { name: "test.mbox", mimeType: "application/mbox", buffer: Buffer.from(mbox) });
    await page.click("[data-import-start]");
    await page.waitForSelector(".import-progress", { hasText: "导入 2" });
    assert.equal(sql("SELECT COUNT(*) AS n FROM messages WHERE subject LIKE '从 mbox 导入%'")[0].n, 2);
    await page.context().close();
  });
});

describe("英文界面", () => {
  test("标签名、写信窗口里的主题不会被翻译", async () => {
    const id = "label-backup";
    sql(`INSERT OR IGNORE INTO labels (id, name, color, sort) VALUES ('${id}', '备用', '#888888', 0)`);
    const page = await open({ lang: "en", locale: "en-US" });
    await page.waitForSelector(".sidebar .nav-label", { hasText: "备用" });
    assert.equal(await page.locator(".sidebar .nav-label", { hasText: "Backup" }).count(), 0);
    await page.keyboard.press("c");
    await page.waitForSelector(".composer.show");
    await page.fill(".composer .subject", "状态：已发货");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".composer-title").textContent(), "状态：已发货");
    await page.context().close();
  });
});
