// 模拟外部接口：
//   /…        Resend：记录发出的邮件，返回 id 和 message_id
//   /cf/…     Cloudflare：域名、MX 记录、Email Routing、Catch-all（只实现添加域名用到的部分）
import { createServer } from "node:http";

// Cloudflare 的状态：mx.test 和 fail.test 都有第三方 MX；fail.test 无论如何都开启不了 Email Routing
function cloudflare() {
  let seq = 0;
  const zones = {
    "z-mx": { id: "z-mx", name: "mx.test", account: { id: "a1" }, routing: false, dns: [], catchAll: null },
    "z-fail": { id: "z-fail", name: "fail.test", account: { id: "a1" }, routing: false, dns: [], catchAll: null },
    "z-perm": { id: "z-perm", name: "perm.test", account: { id: "a1" }, routing: false, dns: [], catchAll: null },
  };
  // 模拟令牌缺少 Email Routing Rules 权限（POST /cf/__perm 切换）
  const perms = { rules: true };
  for (const z of [zones["z-mx"], zones["z-fail"]]) z.dns.push({ id: `r${++seq}`, type: "MX", name: z.name, content: "aspmx.l.google.com", priority: 1 });
  const cfMx = (c) => /mx\.cloudflare\.net$/.test(c);
  const ok = (result) => [200, { success: true, errors: [], result }];
  const fail = (status, code, message) => [status, { success: false, errors: [{ code, message }] }];
  const denied = () => fail(403, 10000, "Authentication error");
  return {
    zones,
    perms,
    handle(method, path, url, body) {
      if (path === "/user") return ok({ id: "u1", email: "owner@example.com" });
      if (path === "/user/tokens/verify") return ok({ id: "t1", status: "active" });
      if (path === "/accounts") return [200, { success: true, errors: [], result: [{ id: "a1", name: "Test" }], result_info: { total_pages: 1 } }];
      if (path === "/accounts/a1/workers/scripts") return ok([{ id: "cf-mailbox" }]);
      if (path === "/graphql") return [200, { data: null, errors: [{ message: "not available in mock" }] }];
      if (path === "/zones" && method === "GET") return ok(Object.values(zones).map((z) => ({ id: z.id, name: z.name, status: "active", account: z.account })));
      const m = path.match(/^\/zones\/([^/]+)(\/.*)?$/);
      const z = m && zones[m[1]];
      if (!z) return fail(404, 1001, "zone not found");
      const rest = m[2] ?? "";
      if (method === "GET" && rest === "") return ok({ id: z.id, name: z.name, account: z.account });
      if (rest === "/dns_records" && method === "GET") {
        const type = url.searchParams.get("type");
        const name = url.searchParams.get("name");
        return ok(z.dns.filter((r) => (!type || r.type === type) && (!name || r.name === name)));
      }
      if (rest === "/dns_records" && method === "POST") {
        const rec = { id: `r${++seq}`, ...body };
        z.dns.push(rec);
        return ok(rec);
      }
      const del = rest.match(/^\/dns_records\/(.+)$/);
      if (del && method === "DELETE") {
        z.dns = z.dns.filter((r) => r.id !== del[1]);
        return ok({ id: del[1] });
      }
      if (rest === "/email/routing" && method === "GET") return ok({ enabled: z.routing });
      if (rest === "/email/routing/dns" && method === "POST") {
        if (z.name === "fail.test") return fail(400, 1000, "Simulated failure");
        if (z.dns.some((r) => r.type === "MX" && !cfMx(r.content))) return fail(400, 2008, "Non-Cloudflare MX records exist");
        z.routing = true;
        for (const n of [1, 2, 3]) if (!z.dns.some((r) => r.content === `route${n}.mx.cloudflare.net`)) z.dns.push({ id: `r${++seq}`, type: "MX", name: z.name, content: `route${n}.mx.cloudflare.net`, priority: n });
        return ok({ enabled: true });
      }
      if (rest === "/email/routing/rules/catch_all") {
        if (!perms.rules) return denied();
        if (method === "PUT") z.catchAll = body;
        return ok(z.catchAll ?? { actions: [{ type: "drop" }], matchers: [{ type: "all" }], enabled: false });
      }
      return fail(404, 7003, "not implemented in mock");
    },
  };
}

export async function startMockResend() {
  const sent = [];
  const cf = cloudflare();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/cf/__state") return json(200, cf.zones);
    if (url.pathname === "/cf/__perm") return (Object.assign(cf.perms, JSON.parse(body || "{}")), json(200, cf.perms));
    if (url.pathname.startsWith("/cf/")) {
      const [status, data] = cf.handle(req.method, url.pathname.slice(3), url, body ? JSON.parse(body) : undefined);
      return json(status, data);
    }
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
