-- 星标、归档、垃圾箱（软删除）
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN bcc_addrs TEXT;           -- 仅发件：密送地址（JSON 数组）

CREATE INDEX idx_messages_deleted ON messages (deleted_at);

-- 草稿：整份草稿以 JSON 存储（含已上传附件的引用）
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 发件身份：显示名与签名。address 可以是完整地址、"@域名"（域名默认）或 "*"（全局默认）
CREATE TABLE identities (
  address TEXT PRIMARY KEY,
  name TEXT,
  signature TEXT,
  updated_at INTEGER NOT NULL
);
