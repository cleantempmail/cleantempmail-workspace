// 确保部署后有可访问的地址（workers.dev）
// 一键部署（Workers Builds）时是非交互环境：账户还没有 workers.dev 子域的话，wrangler 不会替你注册，
// 部署出来的 Worker 没有任何访问地址。这里在部署前补注册账户子域，部署后确认这个 Worker 的 workers.dev 已启用。
// 只在有 CLOUDFLARE_API_TOKEN 时运行（Workers Builds 会提供）；命令行用 wrangler login 时 wrangler 会自己提示注册。

export const wantsWorkersDev = (config) => config.workers_dev === true || (config.workers_dev === undefined && !config.routes?.length);

function client(config) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || config.account_id;
  if (!token || !account) return null;
  return async (method, path, body) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    return (await res?.json().catch(() => null)) ?? { success: false };
  };
}

// 部署前：账户没有 workers.dev 子域就注册一个（Worker 名称 + 随机后缀，之后可以在控制台修改）
export async function ensureAccountSubdomain(config) {
  if (!wantsWorkersDev(config)) return null;
  const api = client(config);
  if (!api) return null;
  const cur = await api("GET", "/workers/subdomain");
  if (cur.result?.subdomain) return cur.result.subdomain;
  if (!cur.errors?.some((e) => e.code === 10007)) return null; // 不是"未注册"，可能是权限问题，交给 wrangler 处理
  const base = String(config.name || "mail").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "mail";
  for (let i = 0; i < 5; i++) {
    const name = `${base}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await api("PUT", "/workers/subdomain", { subdomain: name });
    if (r.success) {
      console.log(`已为账户注册 workers.dev 子域：${name}.workers.dev（可以在控制台「Workers 和 Pages → 账户详细信息」里修改）`);
      return r.result?.subdomain ?? name;
    }
  }
  console.warn("没能自动注册 workers.dev 子域。请在 Cloudflare 控制台打开「Workers 和 Pages」完成子域注册，或给这个 Worker 绑定自定义域名");
  return null;
}

// 部署后：确认这个 Worker 的 workers.dev 地址已启用，并打印访问地址
export async function ensureWorkerReachable(config) {
  if (!wantsWorkersDev(config)) return;
  const api = client(config);
  if (!api) return;
  const sub = (await api("GET", "/workers/subdomain")).result?.subdomain;
  if (!sub) {
    console.warn("这个账户还没有 workers.dev 子域，Worker 暂时没有访问地址。请在控制台注册子域，或在 Worker → Settings → Domains & Routes 绑定自定义域名");
    return;
  }
  const name = config.name;
  const cur = await api("GET", `/workers/scripts/${name}/subdomain`);
  if (cur.success && !cur.result?.enabled) {
    const r = await api("POST", `/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: Boolean(config.preview_urls) });
    if (!r.success) {
      console.warn(`没能启用 workers.dev 地址：${r.errors?.map((e) => e.message).join("; ") ?? "未知错误"}。请在 Worker → Settings → Domains & Routes 手动启用`);
      return;
    }
  }
  console.log(`\n✅ 部署完成，访问地址：https://${name}.${sub}.workers.dev\n`);
}
