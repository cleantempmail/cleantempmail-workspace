#!/usr/bin/env node
// 用 Cloudflare 新的 cf 命令行部署（Beta）。做的事和 npm run deploy（wrangler）一样：
// 判断存储方式 → 准备数据库和存储 → 更新数据库结构 → 部署代码，更新过程中收发不中断。
//
// 配置仍然以 wrangler.jsonc（+ wrangler.local.jsonc）为准：部署时临时生成 cf 需要的
// cloudflare.config.ts 和 wrangler.config.ts，部署完删除。和 wrangler 部署的区别：
//   - cf 只认资源 ID：数据库、KV 的 ID 从当前已部署的 Worker 上读取，或按名称查找，都没有就创建
//   - Worker 上已有的 Secret（APP_SECRET、OAuth 客户端等）会声明出来，新版本沿用原来的值
//   - cf 部署会按配置应用访问域名和 workers.dev 开关。Worker 上绑着配置里没有的自定义域名，
//     或 workers.dev 开关和配置不一致时，脚本会停下：写进 wrangler.local.jsonc，或加 --allow-domain-changes
//
// 用法：npx cf auth login              第一次使用：在浏览器里授权 cf（和 wrangler 的登录是分开的）
//       npm run deploy:cf
//       npm run deploy:cf -- --dry-run   只检查：读取账户信息、生成配置并打包；不创建资源、不改数据库、不上传
//   STORAGE=lite / STORAGE=r2、--switch-storage 的含义和 npm run deploy 相同
//   账户不止一个时，用 CLOUDFLARE_ACCOUNT_ID 指定
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isLite, parseJsonc, readConfig, toLite } from "./config.mjs";
import { ensureAccountSubdomain, ensureWorkerReachable, wantsWorkersDev } from "./workers-dev.mjs";

const dryRun = process.argv.includes("--dry-run");
const forced = process.argv.includes("--switch-storage");
const allowDomainChanges = process.argv.includes("--allow-domain-changes");

const CF_BIN = resolve("node_modules/cf/bin/cf");
const GENERATED = ["cloudflare.config.ts", "wrangler.config.ts"];
const MARKER = "// 由 scripts/deploy-cf.mjs 临时生成";
// 查询类命令在空目录里运行：目录里有 cloudflare.config.ts 时，cf 的每个命令都会先加载它
const scratch = mkdtempSync(join(tmpdir(), "cf-deploy-"));
const env = { ...process.env };
let wroteConfig = false;

function cleanup() {
  if (wroteConfig) for (const f of GENERATED) rmSync(f, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}

function fail(msg) {
  console.error(`\n✘ ${msg}\n`);
  cleanup();
  process.exit(1);
}

// 运行 cf。stdout 是 JSON（分页信息在 stderr）；inherit 时直接显示输出（构建、上传、迁移）
function cf(args, { inherit = false, cwd = scratch } = {}) {
  const r = spawnSync(process.execPath, [CF_BIN, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (inherit) return { ok: r.status === 0 };
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { ok: r.status === 0, json, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "") };
}
const brief = (r) => r.out.trim().split("\n").slice(0, 8).join("\n");

if (Number(process.versions.node.split(".")[0]) < 22) fail(`cf 需要 Node.js 22 或更新版本（当前 ${process.version}）`);
if (!existsSync(CF_BIN)) fail("没有找到 cf：先运行 npm install");

// ---------- 配置、登录、账户 ----------

const base = readConfig();
const local = existsSync("wrangler.local.jsonc") ? parseJsonc(readFileSync("wrangler.local.jsonc", "utf8")) : null;
const withLocal = (c) => (local ? { ...c, ...local, ...(c.vars || local.vars ? { vars: { ...c.vars, ...local.vars } } : {}) } : c);
const preview = withLocal(base);
const name = preview.name;

const who = cf(["auth", "whoami"]);
if (!who.json?.authenticated || who.json.tokenValid === false) fail("cf 还没有登录。先运行：npx cf auth login（或设置 CLOUDFLARE_API_TOKEN）");
if (!env.CLOUDFLARE_ACCOUNT_ID) {
  const accounts = who.json.accounts ?? [];
  if (preview.account_id) env.CLOUDFLARE_ACCOUNT_ID = preview.account_id;
  else if (accounts.length === 1) env.CLOUDFLARE_ACCOUNT_ID = accounts[0].id;
  else fail(`这个登录可以访问 ${accounts.length} 个账户，请用 CLOUDFLARE_ACCOUNT_ID 指定部署到哪个：\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join("\n")}`);
}

// ---------- 当前已部署的 Worker：自定义域名、workers.dev、绑定（资源 ID 和 Secret） ----------

let worker = null;
let deployed = [];
{
  const w = cf(["workers", "get", name]);
  if (w.ok) worker = w.json;
  else if (!/10007|does not exist/i.test(w.out)) fail(`读取 Worker ${name} 失败：\n${brief(w)}`);
}
if (worker) {
  const d = cf(["workers", "deployments", "list", "--worker", name]);
  if (!d.ok) fail(`读取 Worker ${name} 的部署记录失败：\n${brief(d)}`);
  const top = d.json?.deployments?.[0]?.versions?.slice().sort((a, b) => b.percentage - a.percentage)[0];
  if (top) {
    const v = cf(["workers", "versions", "get", top.version_id, "--worker", name]);
    if (!v.ok) fail(`读取当前版本的绑定失败（为避免丢失 Secret，已停止部署）：\n${brief(v)}`);
    deployed = v.json?.bindings ?? v.json?.resources?.bindings ?? [];
  }
}
const deployedBinding = (binding, ...types) => deployed.find((b) => b.name === binding && types.includes(b.type));

// ---------- 资源 ID：配置里写了就用；否则用已部署 Worker 上的；再按名称查找 ----------

function d1ByName(dbName) {
  const r = cf(["d1", "list", "--name", dbName]);
  if (!r.ok) fail(`查询 D1 数据库失败：\n${brief(r)}`);
  return (r.json ?? []).find((d) => d.name === dbName)?.uuid ?? null;
}
const d1Id = (entry) => entry.database_id || deployedBinding(entry.binding, "d1")?.database_id || deployedBinding(entry.binding, "d1")?.id || d1ByName(entry.database_name);

function kvByTitle(title) {
  for (let page = 1; page < 50; page++) {
    const r = cf(["kv", "namespaces", "list", "--per-page", "100", "--page", String(page)]);
    if (!r.ok) fail(`查询 KV 命名空间失败：\n${brief(r)}`);
    const list = r.json ?? [];
    const hit = list.find((n) => n.title === title);
    if (hit) return hit.id;
    if (list.length < 100) return null;
  }
  return null;
}

// ---------- 存储方式（规则与 scripts/deploy.mjs 相同，修改时两边一起改） ----------

const mainDb = preview.d1_databases?.find((d) => d.binding === "DB");
if (!mainDb) fail("配置里没有 DB 数据库");
const dbId = d1Id(mainDb);

// 返回 undefined 表示查询失败（网络、权限问题）——这时不能当成"没有记录"，否则可能切换存储方式、旧邮件读不到
function recorded() {
  if (!dbId) return { mode: null, hasMail: false }; // 第一次部署：数据库还不存在
  const r = cf([
    "d1", "query", dbId, "--sql",
    "SELECT (SELECT value FROM settings WHERE key = 'storage_mode') AS mode, (SELECT COUNT(*) FROM (SELECT 1 FROM messages LIMIT 1)) AS has_mail",
  ]);
  const row = r.json?.[0]?.results?.[0];
  if (r.ok && row) return { mode: row.mode || null, hasMail: Boolean(row.has_mail) };
  if (/no such table/i.test(r.out)) return { mode: null, hasMail: false };
  return undefined;
}

// 账户是否开通了 R2：没开通时 Cloudflare 返回 10042（Please enable R2 through the Cloudflare Dashboard）
function r2Enabled() {
  const r = cf(["r2", "buckets", "list"]);
  return r.ok || !/10042|enable R2/i.test(r.out);
}

const wanted = isLite(base) ? "lite" : process.env.STORAGE === "lite" || process.env.STORAGE === "r2" ? process.env.STORAGE : null;
const rec = recorded();
if (rec === undefined) fail("没能读取数据库里记录的存储方式（网络或登录问题），为避免误切换存储方式，已停止部署。请稍后重试");
const known = rec.mode === "lite" || rec.mode === "r2" ? rec.mode : null;
if (wanted && known && wanted !== known && rec.hasMail && !forced) {
  fail(
    `这个部署一直使用${known === "lite" ? "免绑卡模式（D1 + KV）" : "R2"}存储邮件，本次配置要求改为${wanted === "lite" ? "免绑卡模式" : "R2"}。` +
      "两种存储之间不会自动迁移数据，切换后已有邮件的正文和附件将无法读取。\n  确实要切换，请加上参数：npm run deploy:cf -- --switch-storage",
  );
}
let mode;
let why;
if (wanted) [mode, why] = [wanted, isLite(base) ? "配置文件本身是免绑卡版" : "环境变量 STORAGE 指定"];
else if (known) [mode, why] = [known, "沿用已部署时的存储方式"];
else [mode, why] = r2Enabled() ? ["r2", "账户已开通 R2"] : ["lite", "账户没有开通 R2（需要绑卡），使用免绑卡模式"];
console.log(`存储方式：${mode === "lite" ? "免绑卡模式（D1 + KV）" : "R2"}（${why}）`);
if (local) console.log(`使用 wrangler.local.jsonc 覆盖：${Object.keys(local).join(", ")}`);

const config = withLocal(mode === "lite" ? toLite(base) : base);

// ---------- 访问域名检查：cf 部署会按配置应用自定义域名和 workers.dev 开关 ----------

const routes = (config.routes ?? []).map((r) => (typeof r === "string" ? { pattern: r } : r));
const domains = routes.filter((r) => r.custom_domain).map((r) => r.pattern);
const workersDev = wantsWorkersDev(config);
if (worker) {
  const problems = [];
  const missing = (worker.references?.domains ?? []).map((d) => d.hostname).filter((h) => !domains.includes(h));
  if (missing.length) problems.push(`Worker 绑定着自定义域名 ${missing.join("、")}，但配置里没有，部署后可能被解绑`);
  const devNow = worker.subdomain?.enabled;
  if (typeof devNow === "boolean" && devNow !== workersDev) problems.push(`Worker 的 workers.dev 地址目前是${devNow ? "开启" : "关闭"}的，按配置部署后会${workersDev ? "开启" : "关闭"}`);
  if (problems.length && !allowDomainChanges) {
    const sample = JSON.stringify({ routes: [...domains, ...missing].map((pattern) => ({ pattern, custom_domain: true })), workers_dev: devNow ?? workersDev });
    fail(
      `${problems.join("；\n  ")}。\n  想保持现状：在 wrangler.local.jsonc 里写上（见 README「使用自己的域名」）：\n  ${sample}\n` +
        "  确实要按配置修改访问域名，请加上参数：npm run deploy:cf -- --allow-domain-changes",
    );
  }
}

// ---------- 准备资源（检查模式下只查找，不创建） ----------

const ids = { d1: {}, kv: {} };
for (const d of config.d1_databases ?? []) {
  let id = d.binding === "DB" ? dbId : d1Id(d);
  if (!id && !dryRun) {
    const r = cf(["d1", "create", "--name", d.database_name]);
    id = r.json?.uuid;
    if (!r.ok || !id) fail(`创建 D1 数据库 ${d.database_name} 失败：\n${brief(r)}`);
    console.log(`已创建 D1 数据库：${d.database_name}`);
  }
  if (!id) console.log(`（检查模式）将创建 D1 数据库：${d.database_name}`);
  ids.d1[d.binding] = id ?? null;
}
for (const k of config.kv_namespaces ?? []) {
  const title = `${name}-${k.binding.toLowerCase()}`;
  let id = k.id || deployedBinding(k.binding, "kv_namespace")?.namespace_id || kvByTitle(title);
  if (!id && !dryRun) {
    const r = cf(["kv", "namespaces", "create", "--title", title]);
    id = r.json?.id;
    if (!r.ok || !id) fail(`创建 KV 命名空间 ${title} 失败：\n${brief(r)}`);
    console.log(`已创建 KV 命名空间：${title}`);
  }
  if (!id) console.log(`（检查模式）将创建 KV 命名空间：${title}`);
  ids.kv[k.binding] = id ?? null;
}
for (const b of config.r2_buckets ?? []) {
  if (cf(["r2", "buckets", "get", b.bucket_name]).ok) continue;
  if (dryRun) {
    console.log(`（检查模式）将创建 R2 存储桶：${b.bucket_name}`);
    continue;
  }
  const r = cf(["r2", "buckets", "create", "--name", b.bucket_name]);
  if (!r.ok) fail(`创建 R2 存储桶 ${b.bucket_name} 失败：\n${brief(r)}`);
  console.log(`已创建 R2 存储桶：${b.bucket_name}`);
}

// Worker 上已有的 Secret 声明出来，新版本沿用原来的值；配置里 secrets.required 的也一并声明
const secrets = [...new Set([...deployed.filter((b) => b.type === "secret_text" || b.type === "secret_key").map((b) => b.name), ...(config.secrets?.required ?? [])])];

// ---------- 生成 cf 配置 ----------

const q = JSON.stringify;
function cfConfig() {
  const supported = ["$schema", "name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "routes", "assets", "d1_databases", "r2_buckets", "kv_namespaces", "send_email", "vars", "secrets", "triggers", "ai", "observability", "account_id"];
  const unknown = Object.keys(config).filter((k) => !supported.includes(k));
  if (unknown.length) fail(`配置里有 cf 部署脚本还不支持的字段：${unknown.join(", ")}。请改用 npm run deploy（wrangler），或在 scripts/deploy-cf.mjs 里补上转换`);
  const assetKeys = { not_found_handling: "notFoundHandling", html_handling: "htmlHandling", run_worker_first: "runWorkerFirst" };
  const badAsset = Object.keys(config.assets ?? {}).filter((k) => !assetKeys[k] && k !== "directory" && k !== "binding");
  if (badAsset.length) fail(`assets 里有 cf 部署脚本还不支持的字段：${badAsset.join(", ")}`);
  const badTrigger = Object.keys(config.triggers ?? {}).filter((k) => k !== "crons");
  if (badTrigger.length) fail(`triggers 里有 cf 部署脚本还不支持的字段：${badTrigger.join(", ")}`);
  const badObs = Object.keys(config.observability ?? {}).filter((k) => k !== "enabled");
  if (badObs.length) fail(`observability 里有 cf 部署脚本还不支持的字段：${badObs.join(", ")}`);

  const envLines = [];
  for (const [k, v] of Object.entries(config.vars ?? {})) {
    if (typeof v !== "string") fail(`vars.${k} 不是字符串，cf 部署脚本暂不支持`);
    envLines.push(`${q(k)}: bindings.text(${q(v)}),`);
  }
  for (const d of config.d1_databases ?? []) envLines.push(`${q(d.binding)}: bindings.d1({ name: ${q(d.database_name)}${ids.d1[d.binding] ? `, id: ${q(ids.d1[d.binding])}` : ""} }),`);
  for (const k of config.kv_namespaces ?? []) envLines.push(`${q(k.binding)}: bindings.kv({${ids.kv[k.binding] ? ` id: ${q(ids.kv[k.binding])} ` : ""}}),`);
  for (const b of config.r2_buckets ?? []) envLines.push(`${q(b.binding)}: bindings.r2({ name: ${q(b.bucket_name)} }),`);
  for (const e of config.send_email ?? []) {
    const extra = Object.keys(e).filter((k) => k !== "name");
    if (extra.length) fail(`send_email 的 ${extra.join(", ")} 暂不支持`);
    envLines.push(`${q(e.name)}: bindings.sendEmail({}),`);
  }
  if (config.ai?.binding) envLines.push(`${q(config.ai.binding)}: bindings.ai({}),`);
  if (config.assets?.binding) envLines.push(`${q(config.assets.binding)}: bindings.assets(),`);
  for (const s of secrets) envLines.push(`${q(s)}: bindings.secret(),`);

  const triggerLines = [
    ...routes.filter((r) => !r.custom_domain).map((r) => `triggers.fetch({ pattern: ${q(r.pattern)}${r.zone_name || r.zone_id ? `, zone: ${q(r.zone_name || r.zone_id)}` : ""} }),`),
    ...(config.triggers?.crons ?? []).map((c) => `triggers.scheduled({ schedule: ${q(c)} }),`),
  ];
  const assets = Object.entries(config.assets ?? {}).filter(([k]) => assetKeys[k]).map(([k, v]) => `${assetKeys[k]}: ${q(v)},`);

  const fields = [
    `name: ${q(config.name)},`,
    `compatibilityDate: ${q(config.compatibility_date)},`,
    config.compatibility_flags?.length ? `compatibilityFlags: ${q(config.compatibility_flags)},` : "",
    `entrypoint: ${q(config.main)},`,
    `workersDev: ${workersDev},`,
    config.preview_urls !== undefined ? `previewUrls: ${q(config.preview_urls)},` : "",
    config.observability ? `observability: { enabled: ${q(Boolean(config.observability.enabled))} },` : "",
    assets.length ? `assets: {\n\t\t\t${assets.join("\n\t\t\t")}\n\t\t},` : "",
    domains.length ? `domains: ${q(domains)},` : "",
    triggerLines.length ? `triggers: [\n\t\t\t${triggerLines.join("\n\t\t\t")}\n\t\t],` : "",
    `env: {\n\t\t\t${envLines.join("\n\t\t\t")}\n\t\t},`,
  ].filter(Boolean);

  return `${MARKER}（根据 wrangler.jsonc），部署后自动删除，不要手动修改
import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
\tworker: {
\t\t${fields.join("\n\t\t")}
\t},
});
`;
}

const wranglerConfig = `${MARKER}：cf 用 wrangler 打包时读取的设置
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
\tassetsDirectory: ${q(config.assets?.directory ?? "./public")},
});
`;

const configText = cfConfig();
for (const f of GENERATED) {
  if (existsSync(f) && !readFileSync(f, "utf8").startsWith(MARKER)) fail(`项目里已经有 ${f}。这个脚本会临时生成它，请先移走`);
}
writeFileSync("cloudflare.config.ts", configText);
writeFileSync("wrangler.config.ts", wranglerConfig);
wroteConfig = true;
if (secrets.length) console.log(`沿用 Worker 上已有的 Secret：${secrets.join(", ")}`);

// ---------- 部署 ----------

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
let ok;
try {
  if (dryRun) ok = cf(["deploy", "--dry-run"], { inherit: true, cwd: process.cwd() }).ok;
  else {
    await ensureAccountSubdomain(config);
    // 数据库在部署前已经准备好，所以总是先更新数据库结构、再部署代码
    const dir = resolve(config.d1_databases.find((d) => d.binding === "DB").migrations_dir ?? "migrations");
    const m = cf(["d1", "migrations", "apply", ids.d1.DB, "--dir", dir]);
    ok = m.ok;
    if (!ok) console.error(`\n✘ 更新数据库结构失败，没有部署新代码：\n${brief(m)}\n`);
    else {
      const applied = Array.isArray(m.json) ? m.json : [];
      console.log(applied.length ? `已更新数据库结构：${applied.map((x) => x?.name ?? x).join(", ")}` : "数据库结构已是最新");
    }
    if (ok) ok = cf(["deploy", "--message", `v${version}`, "--tag", `v${version}`], { inherit: true, cwd: process.cwd() }).ok;
    if (ok) {
      cf(["d1", "query", ids.d1.DB, "--sql", `INSERT INTO settings (key, value) VALUES ('storage_mode', '${mode}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`]);
      await ensureWorkerReachable(config);
      const url = domains.length ? `https://${domains[0]}` : workersDev ? cf(["workers", "get", name]).json?.subdomain?.url : null;
      console.log(`\n✅ 已用 cf 部署 v${version}${url ? `，访问地址：${url}` : ""}\n`);
    }
  }
} finally {
  cleanup();
}
process.exit(ok ? 0 : 1);
