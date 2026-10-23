// 模拟 Resend 接口：记录发出的邮件，返回 id 和 message_id
import { createServer } from "node:http";

export async function startMockResend() {
  const sent = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/emails") {
      const data = JSON.parse(body || "{}");
      const id = `re_${sent.length + 1}`;
      // 和真实的 Resend 一样：使用调用方提供的 Message-ID，没有就自己生成
      const messageId = data.headers?.["Message-ID"] ?? `<${id}@resend.test>`;
      sent.push({ id, messageId, ...data });
      return json(200, { id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/emails/")) {
      const e = sent.find((x) => x.id === url.pathname.slice(8));
      return e ? json(200, { id: e.id, message_id: e.messageId }) : json(404, { message: "not found" });
    }
    if (url.pathname === "/__sent") return json(200, sent);
    if (url.pathname === "/domains") return json(200, { data: [] });
    json(404, { message: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, sent, close: () => new Promise((r) => server.close(r)) };
}
