import type Database from 'better-sqlite3';
import type { WatchedAccount } from '../domain/watched-account.js';

interface WatchRow {
  id: number;
  screen_name: string;
  enabled: number;
  bootstrap_completed: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function toDomain(row: WatchRow): WatchedAccount {
  return {
    id: row.id,
    screenName: row.screen_name,
    enabled: row.enabled === 1,
    bootstrapCompleted: row.bootstrap_completed === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WatchRepository {
  constructor(private readonly db: Database.Database) {}

  list(): WatchedAccount[] {
    const rows = this.db
      .prepare('SELECT * FROM watched_accounts ORDER BY id ASC')
      .all() as unknown as WatchRow[];
    return rows.map(toDomain);
  }

  findByScreenName(screenName: string): WatchedAccount | null {
    const row = this.db
      .prepare('SELECT * FROM watched_accounts WHERE screen_name = ?')
      .get(screenName) as unknown as WatchRow | undefined;
    return row ? toDomain(row) : null;
  }

  create(screenName: string): WatchedAccount {
    const info = this.db
      .prepare('INSERT INTO watched_accounts (screen_name) VALUES (?)')
      .run(screenName);
    return this.findById(Number(info.lastInsertRowid)) as WatchedAccount;
  }

  findById(id: number): WatchedAccount | null {
    const row = this.db
      .prepare('SELECT * FROM watched_accounts WHERE id = ?')
      .get(id) as unknown as WatchRow | undefined;
    return row ? toDomain(row) : null;
  }

  setEnabled(id: number, enabled: boolean): WatchedAccount | null {
    this.db
      .prepare("UPDATE watched_accounts SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    return this.findById(id);
  }

  setBootstrapCompleted(id: number, completed: boolean): WatchedAccount | null {
    this.db
      .prepare(
        "UPDATE watched_accounts SET bootstrap_completed = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(completed ? 1 : 0, id);
    return this.findById(id);
  }

  /** 将某账号设为默认（事务内先清全部默认标记）。 */
  setDefault(screenName: string): WatchedAccount | null {
    const run = this.db.transaction(() => {
      this.db.prepare('UPDATE watched_accounts SET is_default = 0').run();
      this.db
        .prepare("UPDATE watched_accounts SET is_default = 1, updated_at = datetime('now') WHERE screen_name = ?")
        .run(screenName);
    });
    run();
    return this.findByScreenName(screenName);
  }

  /** 将第一个账号（id 最小）设为默认；无账号时返回 null。 */
  promoteFirstAsDefault(): WatchedAccount | null {
    const row = this.db
      .prepare('SELECT * FROM watched_accounts ORDER BY id ASC LIMIT 1')
      .get() as unknown as WatchRow | undefined;
    if (!row) return null;
    return this.setDefault(row.screen_name);
  }

  removeByScreenName(screenName: string): boolean {
    const info = this.db.prepare('DELETE FROM watched_accounts WHERE screen_name = ?').run(screenName);
    return info.changes > 0;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM watched_accounts').get() as {
      count: number;
    };
    return row.count;
  }
}
