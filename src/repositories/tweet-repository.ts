import type Database from 'better-sqlite3';
import type { NewTweetInput, Tweet } from '../domain/tweet.js';
import { parseSourceStatus, parseWorkflowStatus, SourceStatus, WorkflowStatus } from '../domain/workflow.js';

interface TweetRow {
  id: number;
  x_tweet_id: string;
  author_screen_name: string;
  author_name: string | null;
  tweet_url: string;
  original_text: string;
  created_at_x: string | null;
  detected_at: string;
  raw_json: string | null;
  media_json: string | null;
  screenshot_path: string | null;
  workflow_status: string;
  source_status: string;
  last_error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

function toDomain(row: TweetRow): Tweet {
  const workflowStatus = parseWorkflowStatus(row.workflow_status);
  const sourceStatus = parseSourceStatus(row.source_status);
  if (workflowStatus === null || sourceStatus === null) {
    throw new Error(`tweet ${row.id} 存在未知状态: workflow=${row.workflow_status} source=${row.source_status}`);
  }
  return {
    id: row.id,
    xTweetId: row.x_tweet_id,
    authorScreenName: row.author_screen_name,
    authorName: row.author_name,
    tweetUrl: row.tweet_url,
    originalText: row.original_text,
    createdAtX: row.created_at_x,
    detectedAt: row.detected_at,
    rawJson: row.raw_json,
    mediaJson: row.media_json,
    screenshotPath: row.screenshot_path,
    workflowStatus,
    sourceStatus,
    lastError: row.last_error,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 推文查询过滤（对应 /列表 的过滤参数，规格 §26）。 */
export type TweetListFilter =
  | 'pending' // 待翻译（DETECTED / SCREENSHOT_READY / QQ_SENT / WAITING_TRANSLATION）
  | 'translated' // 已翻译（TRANSLATED / READY_TO_PUBLISH）
  | 'published' // 已发布（PUBLISHED）
  | 'failed' // 发布失败（PUBLISH_FAILED）
  | 'all';

export interface TweetListOptions {
  filter?: TweetListFilter;
  /** 1-based 页码。 */
  page?: number;
  pageSize?: number;
}

export class DuplicateTweetError extends Error {
  constructor(xTweetId: string) {
    super(`推文已存在: ${xTweetId}`);
    this.name = 'DuplicateTweetError';
  }
}

export class TweetRepository {
  constructor(private readonly db: Database.Database) {}

  /** 插入新推文。x_tweet_id 重复时抛 DuplicateTweetError。 */
  create(input: NewTweetInput): Tweet {
    const mediaJson = input.media && input.media.length > 0 ? JSON.stringify(input.media) : null;
    const rawJson = input.rawJson !== undefined ? JSON.stringify(input.rawJson) : null;
    try {
      const info = this.db
        .prepare(
          `INSERT INTO tweets
             (x_tweet_id, author_screen_name, author_name, tweet_url, original_text,
              created_at_x, detected_at, raw_json, media_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.xTweetId,
          input.authorScreenName,
          input.authorName ?? null,
          input.tweetUrl,
          input.originalText,
          input.createdAtX ?? null,
          new Date().toISOString(),
          rawJson,
          mediaJson,
        );
      return this.findById(Number(info.lastInsertRowid)) as Tweet;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DuplicateTweetError(input.xTweetId);
      }
      throw error;
    }
  }

  /** 若不存在则创建，存在则返回已有记录（用于去重路径）。 */
  findOrCreate(input: NewTweetInput): { tweet: Tweet; created: boolean } {
    const existing = this.findByXId(input.xTweetId);
    if (existing) {
      return { tweet: existing, created: false };
    }
    return { tweet: this.create(input), created: true };
  }

  findById(id: number): Tweet | null {
    const row = this.db.prepare('SELECT * FROM tweets WHERE id = ?').get(id) as unknown as
      | TweetRow
      | undefined;
    return row ? toDomain(row) : null;
  }

  findByXId(xTweetId: string): Tweet | null {
    const row = this.db
      .prepare('SELECT * FROM tweets WHERE x_tweet_id = ?')
      .get(xTweetId) as unknown as TweetRow | undefined;
    return row ? toDomain(row) : null;
  }

  list(options: TweetListOptions = {}): Tweet[] {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const { where, params } = buildListWhere(options.filter ?? 'pending');
    const rows = this.db
      .prepare(`SELECT * FROM tweets ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset) as unknown as TweetRow[];
    return rows.map(toDomain);
  }

  count(options: { filter?: TweetListFilter } = {}): number {
    const { where, params } = buildListWhere(options.filter ?? 'pending');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM tweets ${where}`)
      .get(...params) as { count: number };
    return row.count;
  }

  updateWorkflowStatus(
    id: number,
    workflowStatus: WorkflowStatus,
    extra: { lastError?: string | null; retryCount?: number } = {},
  ): Tweet | null {
    const current = this.findById(id);
    if (!current) {
      return null;
    }
    this.db
      .prepare(
        `UPDATE tweets
         SET workflow_status = ?, last_error = ?, retry_count = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        workflowStatus,
        extra.lastError !== undefined ? extra.lastError : current.lastError,
        extra.retryCount !== undefined ? extra.retryCount : current.retryCount,
        id,
      );
    return this.findById(id);
  }

  setSourceStatus(id: number, sourceStatus: SourceStatus): Tweet | null {
    this.db
      .prepare("UPDATE tweets SET source_status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sourceStatus, id);
    return this.findById(id);
  }

  setScreenshotPath(id: number, screenshotPath: string | null): Tweet | null {
    this.db
      .prepare("UPDATE tweets SET screenshot_path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(screenshotPath, id);
    return this.findById(id);
  }

  /** 需要来源检查的推文（仍在处理中的状态，规格 §12）。 */
  listForSourceCheck(limit = 100): Tweet[] {
    const statuses = [
      WorkflowStatus.WAITING_TRANSLATION,
      WorkflowStatus.TRANSLATED,
      WorkflowStatus.READY_TO_PUBLISH,
      WorkflowStatus.PUBLISH_FAILED,
    ].map((s) => `'${s}'`);
    const rows = this.db
      .prepare(
        `SELECT * FROM tweets
         WHERE source_status = '${SourceStatus.ACTIVE}'
           AND workflow_status IN (${statuses.join(', ')})
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(limit) as unknown as TweetRow[];
    return rows.map(toDomain);
  }

  /** 还没有推文截图的推文（历史/bootstrap 推文补截图用）。 */
  listWithoutScreenshot(limit = 100): Tweet[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tweets
         WHERE screenshot_path IS NULL
         ORDER BY id ASC LIMIT ?`,
      )
      .all(limit) as unknown as TweetRow[];
    return rows.map(toDomain);
  }
}

function buildListWhere(filter: TweetListFilter): { where: string; params: unknown[] } {
  switch (filter) {
    case 'all':
      return { where: '', params: [] };
    case 'pending':
      return {
        where: "WHERE workflow_status IN ('DETECTED', 'SCREENSHOT_READY', 'QQ_SENT', 'WAITING_TRANSLATION')",
        params: [],
      };
    case 'translated':
      return {
        where: "WHERE workflow_status IN ('TRANSLATED', 'READY_TO_PUBLISH')",
        params: [],
      };
    case 'published':
      return { where: "WHERE workflow_status = 'PUBLISHED'", params: [] };
    case 'failed':
      return { where: "WHERE workflow_status = 'PUBLISH_FAILED'", params: [] };
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('UNIQUE constraint failed') ||
      error.message.includes('SQLITE_CONSTRAINT_UNIQUE')
    );
  }
  return false;
}
