#!/usr/bin/env node
// 生成免绑卡版的 wrangler 配置（GitHub Actions 用它维护 lite 分支）
//   node scripts/lite-config.mjs           输出到屏幕
//   node scripts/lite-config.mjs --write   覆盖 wrangler.jsonc
import { writeFileSync } from "node:fs";
import { readConfig, toLite } from "./config.mjs";

const lite = toLite(readConfig());
const out = `// 免绑卡版（由 scripts/lite-config.mjs 自动生成）：不使用 R2，邮件正文存 D1，大附件存 KV\n${JSON.stringify(lite, null, 2)}\n`;
if (process.argv.includes("--write")) writeFileSync("wrangler.jsonc", out);
else process.stdout.write(out);
