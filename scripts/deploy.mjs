#!/usr/bin/env node
// 部署：先更新数据库结构，再部署代码，更新过程中收发不中断。
// 首次部署时数据库还不存在（wrangler deploy 会自动创建），这时先部署、再建表。
// 如果有 wrangler.local.jsonc（不提交到 git），会用其中的字段覆盖 wrangler.jsonc，用来放自定义域名等个人配置。
// 用法：npm run deploy        （等同 node scripts/deploy.mjs）
//       node scripts/deploy.mjs --dry-run   只检查配置和打包
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// 去掉 JSONC 里的注释和尾随逗号（跳过字符串内容）
function parseJsonc(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const base = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
let config = base;
let configArgs = [];
const GENERATED = ".wrangler.deploy.json";
if (existsSync("wrangler.local.jsonc")) {
  const local = parseJsonc(readFileSync("wrangler.local.jsonc", "utf8"));
  config = { ...base, ...local, ...(base.vars || local.vars ? { vars: { ...base.vars, ...local.vars } } : {}) };
  writeFileSync(GENERATED, JSON.stringify(config, null, 2));
  configArgs = ["-c", GENERATED];
  console.log(`使用 wrangler.local.jsonc 覆盖：${Object.keys(local).join(", ")}`);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const wrangler = (args) => spawnSync(npx, ["wrangler", ...args, ...configArgs], { stdio: "inherit" }).status === 0;

// 数据库是否已经存在：一键部署会把 database_id 写进配置；命令行部署按名称查找
function databaseExists() {
  const db = config.d1_databases?.[0];
  if (!db) return false;
  if (db.database_id) return true;
  const r = spawnSync(npx, ["wrangler", "d1", "list", "--json"], { encoding: "utf8" });
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
  else ok = databaseExists() ? migrate() && deploy() : deploy() && migrate();
} finally {
  if (configArgs.length) rmSync(GENERATED, { force: true });
}
process.exit(ok ? 0 : 1);
