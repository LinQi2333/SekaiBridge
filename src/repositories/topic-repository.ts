import type Database from 'better-sqlite3';
import type { BiliTopic, NewBiliTopicInput } from '../domain/topic.js';

interface TopicRow {
  id: number;
  alias: string;
  bili_topic_id: string;
  name: string;
  enabled: number;
  created_at: string;
}

function toDomain(row: TopicRow): BiliTopic {
  return {
    id: row.id,
    alias: row.alias,
    biliTopicId: row.bili_topic_id,
    name: row.name,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export class TopicRepository {
  constructor(private readonly db: Database.Database) {}

  list(onlyEnabled = true): BiliTopic[] {
    const rows = onlyEnabled
      ? (this.db
          .prepare('SELECT * FROM bili_topics WHERE enabled = 1 ORDER BY id ASC')
          .all() as unknown as TopicRow[])
      : (this.db.prepare('SELECT * FROM bili_topics ORDER BY id ASC').all() as unknown as TopicRow[]);
    return rows.map(toDomain);
  }

  findByAlias(alias: string): BiliTopic | null {
    const row = this.db
      .prepare('SELECT * FROM bili_topics WHERE alias = ?')
      .get(alias) as unknown as TopicRow | undefined;
    return row ? toDomain(row) : null;
  }

  create(input: NewBiliTopicInput): BiliTopic {
    const info = this.db
      .prepare('INSERT INTO bili_topics (alias, bili_topic_id, name) VALUES (?, ?, ?)')
      .run(input.alias, input.biliTopicId, input.name);
    return this.findByAlias(input.alias) as BiliTopic;
  }

  setEnabled(id: number, enabled: boolean): BiliTopic | null {
    this.db.prepare('UPDATE bili_topics SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const row = this.db.prepare('SELECT * FROM bili_topics WHERE id = ?').get(id) as unknown as
      | TopicRow
      | undefined;
    return row ? toDomain(row) : null;
  }

  removeByAlias(alias: string): boolean {
    const info = this.db.prepare('DELETE FROM bili_topics WHERE alias = ?').run(alias);
    return info.changes > 0;
  }
}
