#!/usr/bin/env node
// 自动化测试：在临时目录启动本地 Worker（全新的数据库和存储），跑接口测试和浏览器测试。
//   npm test                 标准版（R2）
//   STORAGE=lite npm test    免绑卡版（D1 + KV）
// 浏览器测试需要 Playwright：npm i --no-save playwright && npx playwright install chromium（没装就跳过）
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, toLite } from "../scripts/config.mjs";
import { startMockResend } from "./mock-resend.mjs";

const PORT = Number(process.env.TEST_PORT ?? 8790);
const lite = process.env.STORAGE === "lite";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const persist = mkdtempSync(join(tmpdir(), "cfm-test-"));
const CONFIG = ".wrangler.test.json";

// 测试用配置：去掉需要联网的 Workers AI 和自定义域名
const base = readConfig();
const { ai, routes, route, ...rest } = lite ? toLite(base) : base;
void ai, routes, route;
writeFileSync(CONFIG, JSON.stringify({ ...rest, workers_dev: true }, null, 2));

const mock = await startMockResend();
const vars = { DEV_LOGIN: "1", APP_SECRET: "test-secret-0123456789abcdef", RESEND_API_BASE: mock.url, CF_API_BASE: `${mock.url}/cf`, DEV_CF_API_TOKEN: "test-token" };
const wr = (args, opts = {}) => spawnSync(npx, ["wrangler", ...args, "-c", CONFIG, "--persist-to", persist], { encoding: "utf8", ...opts });

let dev;
let code = 1;
try {
  const m = wr(["d1", "migrations", "apply", "DB", "--local"]);
  if (m.status !== 0) throw new Error("迁移失败：\n" + m.stdout + m.stderr);
  dev = spawn(npx, ["wrangler", "dev", "-c", CONFIG, "--persist-to", persist, "--port", String(PORT), "--ip", "127.0.0.1", "--test-scheduled", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // 独立进程组：结束时连同 workerd 子进程一起关掉
  });
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; ; i++) {
    const ok = await fetch(`${base}/api/me`).then((r) => r.ok, () => false);
    if (ok) break;
    if (i > 90 || dev.exitCode !== null) throw new Error("本地 Worker 没有启动：\n" + log.slice(-3000));
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`本地 Worker 已启动（${lite ? "免绑卡版" : "标准版"}）：${base}\n`);
  const env = { ...process.env, TEST_BASE: base, TEST_MOCK: mock.url, TEST_PERSIST: persist, TEST_CONFIG: CONFIG, TEST_STORAGE: lite ? "lite" : "r2" };
  const files = ["tests/importer.test.mjs", "tests/api.test.mjs"];
  let hasPw = Boolean(process.env.PLAYWRIGHT_MODULE);
  if (!hasPw) hasPw = await import("playwright").then(() => true, () => false);
  if (hasPw) files.push("tests/ui.test.mjs");
  else console.log("（没有安装 Playwright，跳过浏览器测试）\n");
  // 用异步子进程：模拟的 Resend 服务器在本进程里，同步等待会让它无法响应
  code = await new Promise((resolve) => spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], { stdio: "inherit", env }).on("exit", (c) => resolve(c ?? 1)));
  if (code !== 0 && process.env.CI) console.log("\n---- wrangler dev 日志 ----\n" + log.slice(-6000));
} catch (e) {
  console.error(e.message);
} finally {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  await mock.close();
  rmSync(CONFIG, { force: true });
  setTimeout(() => rmSync(persist, { recursive: true, force: true }), 500);
}
process.exitCode = code;
