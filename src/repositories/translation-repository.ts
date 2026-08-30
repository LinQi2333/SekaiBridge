import type Database from 'better-sqlite3';
import type { Translation } from '../domain/translation.js';

interface TranslationRow {
  id: number;
  tweet_id: number;
  qq_user_id: string;
  text: string;
  version: number;
  created_at: string;
}

function toDomain(row: TranslationRow): Translation {
  return {
    id: row.id,
    tweetId: row.tweet_id,
    qqUserId: row.qq_user_id,
    text: row.text,
    version: row.version,
    createdAt: row.created_at,
  };
}

export class TranslationRepository {
  constructor(private readonly db: Database.Database) {}

  /** 计算 tweet 的下一个版本号（tweet 下最大版本 + 1，无记录时为 1）。 */
  nextVersion(tweetId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS max_version FROM translations WHERE tweet_id = ?')
      .get(tweetId) as { max_version: number };
    return row.max_version + 1;
  }

  create(tweetId: number, qqUserId: string, text: string, version: number): Translation {
    const info = this.db
      .prepare('INSERT INTO translations (tweet_id, qq_user_id, text, version) VALUES (?, ?, ?, ?)')
      .run(tweetId, qqUserId, text, version);
    return this.findById(Number(info.lastInsertRowid)) as Translation;
  }

  findById(id: number): Translation | null {
    const row = this.db
      .prepare('SELECT * FROM translations WHERE id = ?')
      .get(id) as unknown as TranslationRow | undefined;
    return row ? toDomain(row) : null;
  }

  /** 最新版本（当前有效版本）。 */
  findLatest(tweetId: number): Translation | null {
    const row = this.db
      .prepare('SELECT * FROM translations WHERE tweet_id = ? ORDER BY version DESC LIMIT 1')
      .get(tweetId) as unknown as TranslationRow | undefined;
    return row ? toDomain(row) : null;
  }

  listByTweet(tweetId: number): Translation[] {
    const rows = this.db
      .prepare('SELECT * FROM translations WHERE tweet_id = ? ORDER BY version ASC')
      .all(tweetId) as unknown as TranslationRow[];
    return rows.map(toDomain);
  }
}
