import type Database from 'better-sqlite3';
import type { NewPublishRecordInput, PublishRecord, PublishStatus } from '../domain/publish.js';

interface PublishRow {
  id: number;
  tweet_id: number;
  translation_id: number | null;
  bili_dynamic_id: string | null;
  bili_topic_id: string | null;
  status: string;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  published_at: string | null;
}

function toDomain(row: PublishRow): PublishRecord {
  return {
    id: row.id,
    tweetId: row.tweet_id,
    translationId: row.translation_id,
    biliDynamicId: row.bili_dynamic_id,
    biliTopicId: row.bili_topic_id,
    status: row.status as PublishStatus,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

export class PublishRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: NewPublishRecordInput): PublishRecord {
    const info = this.db
      .prepare(
        `INSERT INTO publish_records
           (tweet_id, translation_id, bili_dynamic_id, bili_topic_id, status, attempt_count, last_error, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tweetId,
        input.translationId,
        input.biliDynamicId ?? null,
        input.biliTopicId ?? null,
        input.status,
        1,
        input.lastError ?? null,
        input.status === 'SUCCESS' ? new Date().toISOString() : null,
      );
    return this.findById(Number(info.lastInsertRowid)) as PublishRecord;
  }

  findById(id: number): PublishRecord | null {
    const row = this.db.prepare('SELECT * FROM publish_records WHERE id = ?').get(id) as unknown as
      | PublishRow
      | undefined;
    return row ? toDomain(row) : null;
  }

  listByTweet(tweetId: number): PublishRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM publish_records WHERE tweet_id = ? ORDER BY id ASC')
      .all(tweetId) as unknown as PublishRow[];
    return rows.map(toDomain);
  }

  /** 该 tweet 的成功发布记录（幂等检查用）。 */
  findSuccessfulByTweet(tweetId: number): PublishRecord | null {
    const row = this.db
      .prepare("SELECT * FROM publish_records WHERE tweet_id = ? AND status = 'SUCCESS' LIMIT 1")
      .get(tweetId) as unknown as PublishRow | undefined;
    return row ? toDomain(row) : null;
  }

  /** 追加一次失败尝试（attempt_count + 1）。 */
  appendFailure(tweetId: number, lastError: string): PublishRecord {
    const latest = this.listByTweet(tweetId).at(-1);
    const attemptCount = (latest?.attemptCount ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO publish_records
           (tweet_id, translation_id, status, attempt_count, last_error)
         VALUES (?, ?, 'FAILED', ?, ?)`,
      )
      .run(tweetId, latest?.translationId ?? null, attemptCount, lastError);
    return this.findById(Number(info.lastInsertRowid)) as PublishRecord;
  }
}
