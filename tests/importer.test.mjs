// mbox 拆分（浏览器端导入用）：分隔行、>From 还原、CRLF
import assert from "node:assert/strict";
import { test } from "node:test";
import { mboxMessages } from "../public/js/importer.js";

const collect = async (text, chunk = 7) => {
  // 用很小的块读取，测试跨块的分隔行
  const bytes = new TextEncoder().encode(text);
  const file = { stream: () => new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.subarray(i, i + chunk)); c.close(); } }) };
  const out = [];
  for await (const m of mboxMessages(file)) out.push(new TextDecoder().decode(m));
  return out;
};

test("按 From 分隔行拆分，还原 >From", async () => {
  const mbox = [
    "From alice@example.com Mon Jan  5 08:00:00 2026",
    "Subject: one",
    "",
    "body one",
    ">From the start",
    "",
    "From bob@example.com Tue Jan  6 09:00:00 2026",
    "Subject: two",
    "",
    "body two",
    "",
  ].join("\n");
  const msgs = await collect(mbox);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0], "Subject: one\n\nbody one\nFrom the start");
  assert.equal(msgs[1], "Subject: two\n\nbody two");
});

test("正文中间（前面不是空行）的 From 不当作分隔", async () => {
  const mbox = "From a@b Mon Jan  5 08:00:00 2026\nSubject: x\n\nline\nFrom inside text\nend\n";
  const msgs = await collect(mbox, 3);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /From inside text/);
});

test("CRLF 换行", async () => {
  const mbox = "From a@b Mon Jan  5 08:00:00 2026\r\nSubject: a\r\n\r\nA\r\n\r\nFrom c@d Mon Jan  5 09:00:00 2026\r\nSubject: b\r\n\r\nB\r\n";
  const msgs = await collect(mbox, 5);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0], "Subject: a\r\n\r\nA");
  assert.equal(msgs[1], "Subject: b\r\n\r\nB");
});
