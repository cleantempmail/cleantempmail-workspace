#!/usr/bin/env node
// 部署：先更新数据库结构，再部署代码，更新过程中收发不中断。
// 首次部署时数据库还不存在（wrangler deploy 会自动创建），这时先部署、再建表。
//
// 存储方式：
//   - 账户开通了 R2 → 用 R2（标准版）
//   - 没开通 R2（没绑卡）→ 免绑卡模式：邮件正文存 D1，大附件存 KV
//   - 已经部署过的，沿用数据库里记录的方式，不会因为后来开通了 R2 就自动切换（否则旧邮件会读不到）
//   - 也可以用环境变量指定：STORAGE=lite 或 STORAGE=r2；已有邮件时改变存储方式需要加 --switch-storage 确认
// 如果有 wrangler.local.jsonc（不提交到 git），会用其中的字段覆盖配置，用来放自定义域名等个人配置。
//
// 用法：npm run deploy        （等同 node scripts/deploy.mjs）
//       node scripts/deploy.mjs --dry-run   只检查配置和打包
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isLite, parseJsonc, readConfig, toLite } from "./config.mjs";
import { ensureAccountSubdomain, ensureWorkerReachable } from "./workers-dev.mjs";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args, opts = {}) => spawnSync(npx, ["wrangler", ...args], { encoding: "utf8", ...opts });

const base = readConfig();

// 数据库里记录的存储方式（Worker 运行时写入 settings.storage_mode），以及库里有没有邮件。
// 返回 undefined 表示查询失败（网络、登录问题）——这时不能当成"没有记录"，否则可能切换存储方式、旧邮件读不到
function recorded() {
  const r = run([
    "d1", "execute", "DB", "--remote", "--json", "--command",
    "SELECT (SELECT value FROM settings WHERE key = 'storage_mode') AS mode, (SELECT COUNT(*) FROM (SELECT 1 FROM messages LIMIT 1)) AS has_mail",
  ]);
  try {
    const row = JSON.parse(r.stdout)?.[0]?.results?.[0];
    if (row) return { mode: row.mode || null, hasMail: Boolean(row.has_mail) };
  } catch {}
  // 第一次部署：数据库还不存在，或者还没建表
  if (baseDbExists() === false || /no such table/i.test(`${r.stdout}${r.stderr}`)) return { mode: null, hasMail: false };
  return undefined;
}

// 按配置里的名称查找数据库：true / false，查不到列表时返回 null
function baseDbExists() {
  const db = base.d1_databases?.find((d) => d.binding === "DB");
  if (!db) return false;
  if (db.database_id) return true;
  const r = run(["d1", "list", "--json"]);
  try {
    return JSON.parse(r.stdout).some((d) => d.name === db.database_name);
  } catch {
    return null;
  }
}

function fail(msg) {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
}

// 账户是否开通了 R2：没开通时 Cloudflare 返回 10042（Please enable R2 through the Cloudflare Dashboard）
function r2Enabled() {
  const r = run(["r2", "bucket", "list"]);
  if (r.status === 0) return true;
  const out = `${r.stdout}${r.stderr}`;
  if (/10042|enable R2/i.test(out)) return false;
  return true; // 其他错误（例如没登录）交给后面的部署去报错
}

// 存储方式一旦有了邮件就不能悄悄改变：两种存储之间不会自动迁移数据，切换后旧邮件正文会变成空白
const dryRun = process.argv.includes("--dry-run");
const forced = process.argv.includes("--switch-storage");
const wanted = isLite(base) ? "lite" : process.env.STORAGE === "lite" || process.env.STORAGE === "r2" ? process.env.STORAGE : null;
let mode;
let why;
if (dryRun) [mode, why] = [wanted ?? "r2", "检查模式"];
else {
  const rec = recorded();
  if (rec === undefined) fail("没能读取数据库里记录的存储方式（网络或登录问题），为避免误切换存储方式，已停止部署。请稍后重试");
  const known = rec.mode === "lite" || rec.mode === "r2" ? rec.mode : null;
  if (wanted && known && wanted !== known && rec.hasMail && !forced) {
    fail(
      `这个部署一直使用${known === "lite" ? "免绑卡模式（D1 + KV）" : "R2"}存储邮件，本次配置要求改为${wanted === "lite" ? "免绑卡模式" : "R2"}。` +
        "两种存储之间不会自动迁移数据，切换后已有邮件的正文和附件将无法读取。\n  确实要切换，请加上参数：npm run deploy -- --switch-storage",
    );
  }
  if (wanted) [mode, why] = [wanted, isLite(base) ? "配置文件本身是免绑卡版" : "环境变量 STORAGE 指定"];
  else if (known) [mode, why] = [known, "沿用已部署时的存储方式"];
  else [mode, why] = r2Enabled() ? ["r2", "账户已开通 R2"] : ["lite", "账户没有开通 R2（需要绑卡），使用免绑卡模式"];
}

let config = mode === "lite" ? toLite(base) : base;
console.log(`存储方式：${mode === "lite" ? "免绑卡模式（D1 + KV）" : "R2"}（${why}）`);

if (existsSync("wrangler.local.jsonc")) {
  const local = parseJsonc(readFileSync("wrangler.local.jsonc", "utf8"));
  config = { ...config, ...local, ...(config.vars || local.vars ? { vars: { ...config.vars, ...local.vars } } : {}) };
  console.log(`使用 wrangler.local.jsonc 覆盖：${Object.keys(local).join(", ")}`);
}

const GENERATED = ".wrangler.deploy.json";
const custom = config !== base;
if (custom) writeFileSync(GENERATED, JSON.stringify(config, null, 2));
const configArgs = custom ? ["-c", GENERATED] : [];
const wrangler = (args) => run([...args, ...configArgs], { stdio: "inherit" }).status === 0;

// 数据库是否已经存在：一键部署会把 database_id 写进配置；命令行部署按名称查找
function databaseExists() {
  const db = config.d1_databases?.find((d) => d.binding === "DB");
  if (!db) return false;
  if (db.database_id) return true;
  const r = run(["d1", "list", "--json"]);
  try {
    return JSON.parse(r.stdout).some((d) => d.name === db.database_name);
  } catch {
    return false;
  }
}

const migrate = () => wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
const deploy = () => wrangler(["deploy"]);
let ok;
try {
  // --dry-run：只检查配置和打包，不部署、不改数据库
  if (process.argv.includes("--dry-run")) ok = wrangler(["deploy", "--dry-run"]);
  else {
    // 一键部署的新账户可能还没有 workers.dev 子域：先补注册，否则部署出来没有访问地址
    await ensureAccountSubdomain(config);
    ok = databaseExists() ? migrate() && deploy() : deploy() && migrate();
    if (ok) await ensureWorkerReachable(config);
    // 确认切换存储方式后，更新记录，之后的普通部署沿用新的方式
    if (ok) run(["d1", "execute", "DB", "--remote", ...configArgs, "--command", `INSERT INTO settings (key, value) VALUES ('storage_mode', '${mode}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`]);
  }
} finally {
  if (custom) rmSync(GENERATED, { force: true });
}
process.exit(ok ? 0 : 1);
