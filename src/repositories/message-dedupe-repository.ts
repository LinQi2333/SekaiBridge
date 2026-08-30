import type Database from 'better-sqlite3';

/** QQ 消息去重（规格 §43）：OneBot 事件可能重复，按 message_id 幂等。 */
export class MessageDedupeRepository {
  constructor(private readonly db: Database.Database) {}

  /** 已处理过返回 true；否则记录并返回 false。 */
  markProcessed(messageId: string): boolean {
    const exists = this.db.prepare('SELECT 1 FROM qq_messages WHERE message_id = ?').get(messageId);
    if (exists) {
      return true;
    }
    this.db.prepare('INSERT OR IGNORE INTO qq_messages (message_id) VALUES (?)').run(messageId);
    return false;
  }
}
