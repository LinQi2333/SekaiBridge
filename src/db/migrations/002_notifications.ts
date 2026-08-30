/**
 * 002_notifications：QQ 新推文通知队列。
 * NoneBot2 方案下，Node 检测到新推文后生成通知记录，
 * NoneBot2 轮询拉取并发送到 QQ 群，发送成功后 ack。
 */
export const up = `
CREATE TABLE IF NOT EXISTS qq_notifications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id            INTEGER NOT NULL REFERENCES tweets (id) ON DELETE CASCADE,
  text                TEXT    NOT NULL,
  screenshot_path     TEXT,
  video_thumbnails    TEXT,
  status              TEXT    NOT NULL DEFAULT 'PENDING',
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at             TEXT
);

CREATE INDEX IF NOT EXISTS idx_qq_notifications_status ON qq_notifications (status);
`;
