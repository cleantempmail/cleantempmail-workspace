#!/usr/bin/env node
// 更新到最新版本（一键部署的仓库和本仓库没有共同的 git 历史，git pull / merge 用不了，所以这样做）：
//   - 程序文件全部换成最新版本（src、public、migrations、scripts……）
//   - wrangler.jsonc 用最新版本，但保留你自己的 Worker 名称、数据库 / KV / R2 的名称和 ID、访问域名、变量
//   - 不动 wrangler.local.jsonc 和 .github/workflows（GitHub Actions 的令牌不能修改工作流文件）
// 用法（在你自己的仓库里）：node scripts/update-from-upstream.mjs，然后 git push；
// GitHub Actions 里的「Update from upstream」会自动做这两步。
// 这个脚本不依赖仓库里的其他文件：旧仓库的工作流会直接从 GitHub 下载最新的脚本来运行。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const UPSTREAM = process.env.UPSTREAM_REPO || "https://github.com/cleantempmail/cleantempmail-workspace.git";
const dryRun = process.argv.includes("--dry-run");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

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

// 最新配置 + 你自己的部署信息
export function mergeConfig(up, mine) {
  const out = structuredClone(up);
  for (const k of ["name", "account_id", "routes", "route", "workers_dev", "preview_urls"]) if (k in mine) out[k] = mine[k];
  const keep = (list, key, fields) =>
    (list ?? []).map((item) => {
      const m = (mine[key] ?? []).find((x) => x.binding === item.binding);
      const next = { ...item };
      if (m) for (const f of fields) if (m[f] !== undefined) next[f] = m[f];
      return next;
    });
  if (up.d1_databases) out.d1_databases = keep(up.d1_databases, "d1_databases", ["database_name", "database_id", "preview_database_id"]);
  if (up.kv_namespaces) out.kv_namespaces = keep(up.kv_namespaces, "kv_namespaces", ["id", "preview_id"]);
  if (up.r2_buckets) out.r2_buckets = keep(up.r2_buckets, "r2_buckets", ["bucket_name", "preview_bucket_name"]);
  if (mine.vars) out.vars = { ...(up.vars ?? {}), ...mine.vars };
  // 你自己加的其他配置（例如 placement、limits）保留
  for (const k of Object.keys(mine)) if (!(k in out)) out[k] = mine[k];
  return out;
}

const isLite = (cfg) => !cfg.r2_buckets?.length;
const PROTECTED = (f) => f === "wrangler.jsonc" || f === "wrangler.local.jsonc" || f.startsWith(".github/workflows/");
const APP_DIRS = ["src/", "public/", "migrations/", "scripts/", "tests/"];

function main() {
  if (git("status", "--porcelain")) {
    console.error("✘ 有未提交的改动，请先提交或撤销后再更新");
    process.exit(1);
  }
  const mine = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
  const branch = process.env.UPSTREAM_BRANCH || (isLite(mine) ? "lite" : "main");
  console.log(`从 ${UPSTREAM}（${branch} 分支）获取最新版本…`);
  git("fetch", "--depth=1", UPSTREAM, branch);
  const upFiles = new Set(git("ls-tree", "-r", "--name-only", "FETCH_HEAD").split("\n").filter(Boolean));
  const localFiles = git("ls-files").split("\n").filter(Boolean);

  const take = [...upFiles].filter((f) => !PROTECTED(f));
  for (let i = 0; i < take.length; i += 200) git("checkout", "FETCH_HEAD", "--", ...take.slice(i, i + 200));
  // 最新版本里已经删掉的程序文件
  for (const f of localFiles) if (!upFiles.has(f) && APP_DIRS.some((d) => f.startsWith(d)) && existsSync(f)) rmSync(f);

  const up = parseJsonc(git("show", "FETCH_HEAD:wrangler.jsonc"));
  const merged = mergeConfig(up, mine);
  writeFileSync("wrangler.jsonc", `// 由 scripts/update-from-upstream.mjs 更新：最新配置 + 你自己的名称、数据库 ID、访问域名\n${JSON.stringify(merged, null, 2)}\n`);

  git("add", "-A");
  if (!git("status", "--porcelain")) {
    console.log("✔ 已经是最新版本");
    return;
  }
  const version = existsSync("src/version.ts") ? readFileSync("src/version.ts", "utf8").match(/VERSION\s*=\s*"([\d.]+)"/)?.[1] : null;
  if (dryRun) {
    console.log(git("status", "--short"));
    git("reset", "--hard", "HEAD");
    console.log("（--dry-run：只显示会改动的文件，没有提交）");
    return;
  }
  git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-q", "-m", `Update to ${version ? "v" + version : "the latest version"}`);
  console.log(`✔ 已更新到 ${version ? "v" + version : "最新版本"}。推送后 Cloudflare 会自动重新部署，并更新数据库结构`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("update-from-upstream.mjs")) main();
