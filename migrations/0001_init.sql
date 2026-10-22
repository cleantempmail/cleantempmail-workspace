-- 键值配置：app_secret、owner_user_id、account_id、resend_api_key(加密) 等
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT,
  tokens TEXT,              -- 加密后的 OAuth token JSON
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE domains (
  name TEXT PRIMARY KEY,    -- example.com
  zone_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  receive_status TEXT NOT NULL,          -- active | error
  send_provider TEXT NOT NULL,           -- cloudflare | resend | none
  send_status TEXT NOT NULL,             -- active | pending | error | none
  send_detail TEXT,                      -- 最近一次配置结果/错误说明
  send_meta TEXT,                        -- JSON，例如 Resend domain id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  folder TEXT NOT NULL,                  -- inbox | sent
  mailbox TEXT NOT NULL,                 -- 本方地址：收件时为信封收件人，发件时为发件人
  domain TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  from_name TEXT,
  reply_to TEXT,
  to_addrs TEXT NOT NULL,                -- JSON 数组
  cc_addrs TEXT,                         -- JSON 数组
  subject TEXT,
  snippet TEXT,
  message_id TEXT,                       -- RFC 5322 Message-ID（含尖括号）
  in_reply_to TEXT,
  refs TEXT,
  thread_id TEXT NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  provider TEXT,                         -- 发件使用的服务
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_folder ON messages (folder, created_at DESC);
CREATE INDEX idx_messages_mailbox ON messages (mailbox, created_at DESC);
CREATE INDEX idx_messages_domain ON messages (domain, created_at DESC);
CREATE INDEX idx_messages_thread ON messages (thread_id, created_at);
CREATE INDEX idx_messages_message_id ON messages (message_id);
