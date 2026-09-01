/**
 * 004_per_account：多账号分离——按账号独立编号 + 默认账号。
 * - watched_accounts.is_default：默认账号（唯一）
 * - tweets.seq：账号内编号（发布顺序递增），display 用；全局 id 仍作内部外键
 */
export const up = `
ALTER TABLE watched_accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_watched_default
  ON watched_accounts (is_default) WHERE is_default = 1;

ALTER TABLE tweets ADD COLUMN seq INTEGER;
UPDATE tweets SET seq = (
  SELECT COUNT(*) FROM tweets t2
  WHERE t2.author_screen_name = tweets.author_screen_name AND t2.id <= tweets.id
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tweets_account_seq
  ON tweets (author_screen_name, seq);

-- 首个监听账号自动设为默认
UPDATE watched_accounts SET is_default = 1
WHERE id = (SELECT MIN(id) FROM watched_accounts);
`;
