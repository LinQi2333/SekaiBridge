/**
 * 001_init：初始 schema。
 * 覆盖规格 §9 / §10 / §29 / §31 / §37 / §43 的全部表。
 */
export const up = `
CREATE TABLE IF NOT EXISTS watched_accounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_name        TEXT    NOT NULL UNIQUE,
  enabled            INTEGER NOT NULL DEFAULT 1,
  bootstrap_completed INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tweets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  x_tweet_id          TEXT    NOT NULL UNIQUE,
  author_screen_name  TEXT    NOT NULL,
  author_name         TEXT,
  tweet_url           TEXT    NOT NULL,
  original_text       TEXT    NOT NULL,
  created_at_x        TEXT,
  detected_at         TEXT    NOT NULL,
  raw_json            TEXT,
  media_json          TEXT,
  screenshot_path     TEXT,
  workflow_status     TEXT    NOT NULL DEFAULT 'DETECTED',
  source_status       TEXT    NOT NULL DEFAULT 'ACTIVE',
  topic_alias         TEXT,
  last_error          TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tweets_workflow_status ON tweets (workflow_status);
CREATE INDEX IF NOT EXISTS idx_tweets_source_status  ON tweets (source_status);
CREATE INDEX IF NOT EXISTS idx_tweets_author         ON tweets (author_screen_name);

CREATE TABLE IF NOT EXISTS translations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id   INTEGER NOT NULL REFERENCES tweets (id) ON DELETE CASCADE,
  qq_user_id TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tweet_id, version)
);

CREATE INDEX IF NOT EXISTS idx_translations_tweet ON translations (tweet_id);

CREATE TABLE IF NOT EXISTS bili_topics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  alias         TEXT    NOT NULL UNIQUE,
  bili_topic_id TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publish_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id        INTEGER NOT NULL REFERENCES tweets (id) ON DELETE CASCADE,
  translation_id  INTEGER REFERENCES translations (id),
  bili_dynamic_id TEXT,
  bili_topic_id   TEXT,
  status          TEXT    NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 1,
  last_error      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  published_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_publish_records_tweet ON publish_records (tweet_id);

-- 幂等发布（规格 §38 / §37）：同一 tweet 只能有一条 SUCCESS 发布记录。
CREATE UNIQUE INDEX IF NOT EXISTS uq_publish_success_tweet
  ON publish_records (tweet_id) WHERE status = 'SUCCESS';

-- QQ 消息去重（规格 §43）：OneBot 事件可能重复。
CREATE TABLE IF NOT EXISTS qq_messages (
  message_id   TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
