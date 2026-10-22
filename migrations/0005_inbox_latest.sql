-- mailbox_stats.last_at 改为"最近一封进入收件箱的邮件时间"：之前包含已发送邮件，发信后会误报"收到新邮件"
UPDATE mailbox_stats SET last_at = COALESCE((
  SELECT MAX(created_at) FROM messages m
  WHERE m.mailbox = mailbox_stats.mailbox AND m.folder = 'inbox' AND m.spam = 0 AND m.archived = 0 AND m.deleted_at IS NULL
), 0);
