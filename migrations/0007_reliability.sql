-- 0007：可靠性与 D1 额度优化

-- 定时发送：记录领取时间和尝试次数，卡在"发送中"的可以识别出来
ALTER TABLE scheduled ADD COLUMN claimed_at INTEGER;
ALTER TABLE scheduled ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- 收信分两步：先存原文和信头（parse_error = 'pending'），解析完再补全；中途被中断的由定时任务收尾
CREATE INDEX idx_messages_pending ON messages (created_at) WHERE parse_error = 'pending';
-- 垃圾邮件清理、清空垃圾邮件
CREATE INDEX idx_messages_spam_live ON messages (created_at) WHERE spam = 1 AND deleted_at IS NULL;
-- 收信时判断发件人是否联系过（主键是 (domain, address)，按地址查用不上）
CREATE INDEX idx_contacts_address ON contacts (address);

-- 列表视图的部分索引（之前要扫整张 threads 表）
CREATE INDEX idx_threads_starred ON threads (sort_at DESC) WHERE starred = 1;
CREATE INDEX idx_threads_sent ON threads (sort_at DESC) WHERE n_sent > 0;
CREATE INDEX idx_threads_spam ON threads (sort_at DESC) WHERE n_spam > 0;
CREATE INDEX idx_threads_archive ON threads (sort_at DESC) WHERE n_archive > 0 AND n_inbox = 0;

-- 发件人通过 DMARC 验证才显示品牌头像（防冒充）
ALTER TABLE threads ADD COLUMN last_verified INTEGER NOT NULL DEFAULT 0;
UPDATE threads SET last_verified = COALESCE((
  SELECT CASE WHEN json_valid(m.auth) AND json_extract(m.auth, '$.dmarc') = 'pass' THEN 1 ELSE 0 END
  FROM messages m WHERE m.id = threads.last_id
), 0);

-- 彻底删除时没删掉的文件，由定时任务重试
CREATE TABLE blob_trash (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 系统事件（收信失败等），设置 → 系统状态里显示
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_time ON events (created_at);

-- 地址计数改为触发器增量维护（之前每封来信、每次操作都对整个地址全量重算）
-- 收件箱可见：未删除、收件、非垃圾、未归档、已解析完成
DELETE FROM mailbox_stats;
INSERT INTO mailbox_stats (mailbox, domain, total, unread, spam, last_at)
  SELECT mailbox, domain, COUNT(*),
    SUM(CASE WHEN folder = 'inbox' AND is_read = 0 AND archived = 0 AND spam = 0 AND COALESCE(parse_error, '') != 'pending' THEN 1 ELSE 0 END),
    SUM(spam),
    COALESCE(MAX(CASE WHEN folder = 'inbox' AND spam = 0 AND archived = 0 AND COALESCE(parse_error, '') != 'pending' THEN created_at END), 0)
  FROM messages WHERE deleted_at IS NULL GROUP BY mailbox;

-- 全部地址的合计（管理员轮询只读这一行）
CREATE TABLE stats_total (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  unread INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO stats_total (id, unread, last_at) SELECT 1, COALESCE(SUM(unread), 0), COALESCE(MAX(last_at), 0) FROM mailbox_stats;

CREATE TRIGGER trg_messages_stats_insert AFTER INSERT ON messages WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO mailbox_stats (mailbox, domain, total, unread, spam, last_at) VALUES (
    NEW.mailbox, NEW.domain, 1,
    NEW.folder = 'inbox' AND NEW.is_read = 0 AND NEW.archived = 0 AND NEW.spam = 0 AND COALESCE(NEW.parse_error, '') != 'pending',
    NEW.spam,
    CASE WHEN NEW.folder = 'inbox' AND NEW.spam = 0 AND NEW.archived = 0 AND COALESCE(NEW.parse_error, '') != 'pending' THEN NEW.created_at ELSE 0 END
  ) ON CONFLICT (mailbox) DO UPDATE SET
    total = total + excluded.total, unread = unread + excluded.unread, spam = spam + excluded.spam, last_at = MAX(last_at, excluded.last_at);
  UPDATE stats_total SET
    unread = unread + (NEW.folder = 'inbox' AND NEW.is_read = 0 AND NEW.archived = 0 AND NEW.spam = 0 AND COALESCE(NEW.parse_error, '') != 'pending'),
    last_at = MAX(last_at, CASE WHEN NEW.folder = 'inbox' AND NEW.spam = 0 AND NEW.archived = 0 AND COALESCE(NEW.parse_error, '') != 'pending' THEN NEW.created_at ELSE 0 END)
  WHERE id = 1;
END;

CREATE TRIGGER trg_messages_stats_delete AFTER DELETE ON messages WHEN OLD.deleted_at IS NULL
BEGIN
  UPDATE mailbox_stats SET
    total = total - 1,
    unread = unread - (OLD.folder = 'inbox' AND OLD.is_read = 0 AND OLD.archived = 0 AND OLD.spam = 0 AND COALESCE(OLD.parse_error, '') != 'pending'),
    spam = spam - OLD.spam
  WHERE mailbox = OLD.mailbox;
  UPDATE stats_total SET
    unread = unread - (OLD.folder = 'inbox' AND OLD.is_read = 0 AND OLD.archived = 0 AND OLD.spam = 0 AND COALESCE(OLD.parse_error, '') != 'pending')
  WHERE id = 1;
END;

CREATE TRIGGER trg_messages_stats_update AFTER UPDATE OF is_read, archived, spam, deleted_at, folder, parse_error ON messages
BEGIN
  INSERT INTO mailbox_stats (mailbox, domain, total, unread, spam, last_at) VALUES (
    NEW.mailbox, NEW.domain,
    (NEW.deleted_at IS NULL) - (OLD.deleted_at IS NULL),
    (NEW.deleted_at IS NULL AND NEW.folder = 'inbox' AND NEW.is_read = 0 AND NEW.archived = 0 AND NEW.spam = 0 AND COALESCE(NEW.parse_error, '') != 'pending')
      - (OLD.deleted_at IS NULL AND OLD.folder = 'inbox' AND OLD.is_read = 0 AND OLD.archived = 0 AND OLD.spam = 0 AND COALESCE(OLD.parse_error, '') != 'pending'),
    (NEW.deleted_at IS NULL AND NEW.spam = 1) - (OLD.deleted_at IS NULL AND OLD.spam = 1),
    CASE WHEN NEW.deleted_at IS NULL AND NEW.folder = 'inbox' AND NEW.spam = 0 AND NEW.archived = 0 AND COALESCE(NEW.parse_error, '') != 'pending' THEN NEW.created_at ELSE 0 END
  ) ON CONFLICT (mailbox) DO UPDATE SET
    total = total + excluded.total, unread = unread + excluded.unread, spam = spam + excluded.spam, last_at = MAX(last_at, excluded.last_at);
  UPDATE stats_total SET
    unread = unread
      + (NEW.deleted_at IS NULL AND NEW.folder = 'inbox' AND NEW.is_read = 0 AND NEW.archived = 0 AND NEW.spam = 0 AND COALESCE(NEW.parse_error, '') != 'pending')
      - (OLD.deleted_at IS NULL AND OLD.folder = 'inbox' AND OLD.is_read = 0 AND OLD.archived = 0 AND OLD.spam = 0 AND COALESCE(OLD.parse_error, '') != 'pending'),
    last_at = MAX(last_at, CASE WHEN NEW.deleted_at IS NULL AND NEW.folder = 'inbox' AND NEW.spam = 0 AND NEW.archived = 0 AND COALESCE(NEW.parse_error, '') != 'pending' THEN NEW.created_at ELSE 0 END)
  WHERE id = 1;
END;
