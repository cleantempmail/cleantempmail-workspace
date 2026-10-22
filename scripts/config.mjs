// wrangler 配置的读取与转换（部署脚本、免绑卡版分支共用）
import { readFileSync } from "node:fs";

// 去掉 JSONC 里的注释和尾随逗号（跳过字符串内容）
export function parseJsonc(src) {
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

export const readConfig = (file = "wrangler.jsonc") => parseJsonc(readFileSync(file, "utf8"));

export const isLite = (config) => !config.r2_buckets?.length;

// 免绑卡版：去掉 R2；邮件正文和小文件存在单独的 D1 库（BLOBS），大于 512 KB 的文件存 KV
export function toLite(config) {
  if (isLite(config)) return config;
  const { r2_buckets, ...rest } = config;
  const main = config.d1_databases.find((d) => d.binding === "DB");
  return {
    ...rest,
    d1_databases: [...config.d1_databases.filter((d) => d.binding !== "BLOBS"), { binding: "BLOBS", database_name: `${main.database_name}-blobs` }],
    kv_namespaces: [...(config.kv_namespaces ?? []).filter((k) => k.binding !== "KV"), { binding: "KV" }],
  };
}
