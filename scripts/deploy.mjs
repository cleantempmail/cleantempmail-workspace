#!/usr/bin/env node
// 部署：先更新数据库结构，再部署代码，更新过程中收发不中断。
// 首次部署时数据库还不存在（wrangler deploy 会自动创建），这时先部署、再建表。
//
// 存储方式：
//   - 账户开通了 R2 → 用 R2（标准版）
//   - 没开通 R2（没绑卡）→ 免绑卡模式：邮件正文存 D1，大附件存 KV
//   - 已经部署过的，沿用数据库里记录的方式，不会因为后来开通了 R2 就自动切换（否则旧邮件会读不到）
//   - 也可以用环境变量强制指定：STORAGE=lite 或 STORAGE=r2
// 如果有 wrangler.local.jsonc（不提交到 git），会用其中的字段覆盖配置，用来放自定义域名等个人配置。
//
// 用法：npm run deploy        （等同 node scripts/deploy.mjs）
//       node scripts/deploy.mjs --dry-run   只检查配置和打包
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isLite, parseJsonc, readConfig, toLite } from "./config.mjs";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args, opts = {}) => spawnSync(npx, ["wrangler", ...args], { encoding: "utf8", ...opts });

const base = readConfig();

// 数据库里记录的存储方式（Worker 运行时写入 settings.storage_mode）
function recordedMode() {
  const r = run(["d1", "execute", "DB", "--remote", "--json", "--command", "SELECT value FROM settings WHERE key = 'storage_mode'"]);
  try {
    return JSON.parse(r.stdout)?.[0]?.results?.[0]?.value || null;
  } catch {
    return null;
  }
}

// 账户是否开通了 R2：没开通时 Cloudflare 返回 10042（Please enable R2 through the Cloudflare Dashboard）
function r2Enabled() {
  const r = run(["r2", "bucket", "list"]);
  if (r.status === 0) return true;
  const out = `${r.stdout}${r.stderr}`;
  if (/10042|enable R2/i.test(out)) return false;
  return true; // 其他错误（例如没登录）交给后面的部署去报错
}

let mode;
let why;
if (isLite(base)) [mode, why] = ["lite", "配置文件本身是免绑卡版"];
else if (process.env.STORAGE === "lite" || process.env.STORAGE === "r2") [mode, why] = [process.env.STORAGE, "环境变量 STORAGE 指定"];
else if (!process.argv.includes("--dry-run")) {
  const rec = recordedMode();
  if (rec === "lite" || rec === "r2") [mode, why] = [rec, "沿用已部署时的存储方式"];
  else [mode, why] = r2Enabled() ? ["r2", "账户已开通 R2"] : ["lite", "账户没有开通 R2（需要绑卡），使用免绑卡模式"];
} else [mode, why] = ["r2", "检查模式默认"];

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
  if (process.argv.includes("--dry-run")) ok = wrangler(["deploy", "--dry-run"]);
  else ok = databaseExists() ? migrate() && deploy() : deploy() && migrate();
} finally {
  if (custom) rmSync(GENERATED, { force: true });
}
process.exit(ok ? 0 : 1);
