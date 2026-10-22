-- ========== 邮件新字段 ==========
ALTER TABLE messages ADD COLUMN spam INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN auth TEXT;                -- JSON：{spf,dkim,dmarc,score}
ALTER TABLE messages ADD COLUMN list_unsub TEXT;          -- JSON：{url,mailto,oneClick}
ALTER TABLE messages ADD COLUMN delivery_status TEXT;     -- 仅发件：sent | delivered | bounced | failed | rejected
ALTER TABLE messages ADD COLUMN delivery_detail TEXT;
ALTER TABLE messages ADD COLUMN provider_id TEXT;         -- 发件服务返回的 id（查询投递状态用）
ALTER TABLE messages ADD COLUMN is_bounce INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN parse_error TEXT;
ALTER TABLE messages ADD COLUMN att_count INTEGER;      -- R2 中 att/0..n-1 的数量（删除时用）

-- 同一收件地址的同一 Message-ID 只入库一次（并发重投也安全）
CREATE UNIQUE INDEX idx_messages_dedupe ON messages (mailbox, message_id) WHERE folder = 'inbox' AND message_id IS NOT NULL;
CREATE INDEX idx_messages_provider ON messages (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX idx_messages_live_mailbox ON messages (mailbox, deleted_at, created_at);
CREATE INDEX idx_messages_live_domain ON messages (domain, deleted_at, created_at);

-- ========== 会话汇总（列表与计数都走这里，避免全表扫描） ==========
CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  sort_at INTEGER NOT NULL,          -- 排序时间：最后一封的时间，或"稍后提醒"到期时间
  last_at INTEGER NOT NULL,
  last_id TEXT,
  last_folder TEXT,
  last_mailbox TEXT,
  last_from_addr TEXT,
  last_from_name TEXT,
  last_to_addrs TEXT,
  subject TEXT,
  snippet TEXT,
  participants TEXT,                 -- JSON
  mailboxes TEXT NOT NULL DEFAULT ',',   -- ",a@x.com,b@y.com,"
  domains TEXT NOT NULL DEFAULT ',',
  cnt INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  has_att INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  n_inbox INTEGER NOT NULL DEFAULT 0,    -- 未归档、非垃圾的收件
  n_archive INTEGER NOT NULL DEFAULT 0,
  n_sent INTEGER NOT NULL DEFAULT 0,
  n_spam INTEGER NOT NULL DEFAULT 0,
  n_trash INTEGER NOT NULL DEFAULT 0,
  n_live INTEGER NOT NULL DEFAULT 0,
  trash_at INTEGER,
  snooze_until INTEGER,
  unsnoozed_at INTEGER,
  delivery TEXT                      -- 最近一封发件的投递状态
);
CREATE INDEX idx_threads_sort ON threads (sort_at DESC, thread_id DESC);
CREATE INDEX idx_threads_inbox ON threads (sort_at DESC) WHERE n_inbox > 0;
CREATE INDEX idx_threads_trash ON threads (trash_at DESC) WHERE n_trash > 0;
CREATE INDEX idx_threads_snooze ON threads (snooze_until) WHERE snooze_until IS NOT NULL;

-- 每个地址的计数（侧栏、轮询用）
CREATE TABLE mailbox_stats (
  mailbox TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  spam INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0
);

-- 联系人（按域名隔离，供团队成员按权限使用）
CREATE TABLE contacts (
  domain TEXT NOT NULL,
  address TEXT NOT NULL,
  name TEXT,
  n INTEGER NOT NULL DEFAULT 1,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (domain, address)
);
CREATE INDEX idx_contacts_rank ON contacts (n DESC, last_at DESC);

-- 全文搜索（中日韩文字在写入前按字切分，见 src/search.ts）
CREATE VIRTUAL TABLE messages_fts USING fts5 (subject, people, body, tokenize = 'unicode61 remove_diacritics 2');

-- ========== 地址管理、屏蔽、规则、标签 ==========
CREATE TABLE addresses (
  address TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  note TEXT,
  color TEXT,
  muted INTEGER NOT NULL DEFAULT 0,      -- 不推送通知
  blocked INTEGER NOT NULL DEFAULT 0,    -- 停用：以后直接拒收
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);

CREATE TABLE blocklist (
  pattern TEXT PRIMARY KEY,              -- 完整地址，或 "@example.com"
  action TEXT NOT NULL DEFAULT 'spam',   -- spam | reject
  created_at INTEGER NOT NULL
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_all INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL,              -- JSON [{field, op, value}]
  actions TEXT NOT NULL,                 -- JSON {labels:[], archive, star, read, spam, mute, forward}
  sort INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE thread_labels (
  thread_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, label_id)
);
CREATE INDEX idx_thread_labels_label ON thread_labels (label_id);

-- ========== 写信相关 ==========
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT,
  html TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE scheduled (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  payload TEXT NOT NULL,                 -- 与 /api/send 相同的 JSON
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sending | sent | failed
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_scheduled_due ON scheduled (status, send_at);

ALTER TABLE drafts ADD COLUMN owner TEXT;

-- ========== 推送、成员 ==========
CREATE TABLE push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  keys TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  scope TEXT NOT NULL,                   -- JSON {all:boolean, domains:[], addresses:[]}
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE login_tokens (
  hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

-- ========== 回填现有数据 ==========
INSERT OR IGNORE INTO addresses (address, domain, first_at, last_at)
  SELECT mailbox, domain, MIN(created_at), MAX(created_at) FROM messages GROUP BY mailbox;

INSERT OR IGNORE INTO contacts (domain, address, name, n, last_at)
  SELECT domain, lower(from_addr), MAX(from_name), COUNT(*), MAX(created_at)
  FROM messages WHERE folder = 'inbox' GROUP BY domain, lower(from_addr);

INSERT INTO contacts (domain, address, name, n, last_at)
  SELECT m.domain, lower(json_extract(j.value, '$.address')), json_extract(j.value, '$.name'), COUNT(*), MAX(m.created_at)
  FROM messages m, json_each(m.to_addrs) j WHERE m.folder = 'sent' AND json_extract(j.value, '$.address') IS NOT NULL
  GROUP BY m.domain, lower(json_extract(j.value, '$.address'))
  ON CONFLICT (domain, address) DO UPDATE SET n = n + excluded.n, last_at = MAX(last_at, excluded.last_at);

UPDATE drafts SET owner = (SELECT value FROM settings WHERE key = 'owner_user_id') WHERE owner IS NULL;
-- threads / mailbox_stats / messages_fts 由 Worker 在首次请求时回填（需要 JS 处理中文分词与参与人）
