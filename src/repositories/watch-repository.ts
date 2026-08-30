import type Database from 'better-sqlite3';
import type { WatchedAccount } from '../domain/watched-account.js';

interface WatchRow {
  id: number;
  screen_name: string;
  enabled: number;
  bootstrap_completed: number;
  created_at: string;
  updated_at: string;
}

function toDomain(row: WatchRow): WatchedAccount {
  return {
    id: row.id,
    screenName: row.screen_name,
    enabled: row.enabled === 1,
    bootstrapCompleted: row.bootstrap_completed === 1,
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
