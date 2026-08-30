import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations/index.js';

export interface DatabaseOptions {
  /** SQLite 文件路径；':memory:' 可用于测试。 */
  path: string;
  /** 是否自动执行迁移（默认 true）。 */
  migrate?: boolean;
}

/**
 * SQLite 数据库封装（规格 §44）：
 * - WAL
 * - foreign_keys = ON
 * - 基于 schema_migrations 的迁移
 */
export class AppDatabase {
  readonly db: Database.Database;
  readonly path: string;

  constructor(options: DatabaseOptions) {
    if (options.path !== ':memory:') {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
    }
    this.path = options.path;
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (options.migrate ?? true) {
      this.migrate();
    }
  }

  /** 应用所有未执行的迁移，每个迁移在事务中执行。 */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
        (row) => row.version,
      ),
    );

    const insert = this.db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
    const runInTransaction = this.db.transaction((version: number, name: string, sql: string) => {
      this.db.exec(sql);
      insert.run(version, name);
    });

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      runInTransaction(migration.version, migration.name, migration.up);
    }
  }

  /** 已应用的迁移版本列表（升序）。 */
  appliedVersions(): number[] {
    const rows = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    return rows.map((row) => row.version);
  }

  close(): void {
    this.db.close();
  }
}
