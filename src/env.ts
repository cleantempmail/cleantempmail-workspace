export interface Env {
  DB: D1Database;
  // 文件存储：有 R2 用 R2；没有 R2（免绑卡模式）时用 BLOBS（D1，可选，默认用主库）+ KV（大文件）
  MAIL?: R2Bucket;
  BLOBS?: D1Database;
  KV?: KVNamespace;
  EMAIL: SendEmail;
  ASSETS: Fetcher;
  AI?: Ai;
  WORKER_NAME: string;
  // 可选：用于加密 token / API Key 的密钥（Worker Secret），与 D1 数据分开存放
  APP_SECRET?: string;
  RESEND_API_BASE?: string; // 仅本地测试：把 Resend 接口指向模拟服务
  // 用 `wrangler secret put` 设置，见 README
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_CLIENT_SECRET?: string;
  // 仅本地开发：在 localhost 上跳过 OAuth，可选配一个 API token 用于调用 Cloudflare API
  DEV_LOGIN?: string;
  DEV_CF_API_TOKEN?: string;
}

export interface Scope {
  all: boolean;
  domains: string[];
  addresses: string[];
}

export interface Session {
  id: string; // 会话 id 的哈希（数据库主键）
  userId: string; // Cloudflare 用户 id，或 "member:<id>"
  email: string | null;
  role: "admin" | "member";
  scope: Scope;
  hasCfToken: boolean;
  tokens?: string | null; // 加密的 OAuth token（仅服务端使用）
}

export type Vars = { session: Session };
export type AppEnv = { Bindings: Env; Variables: Vars };
