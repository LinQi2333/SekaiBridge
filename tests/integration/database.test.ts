import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../src/db/database.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;

afterEach(() => {
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

describe('AppDatabase（规格 §44）', () => {
  it('开启 WAL 与 foreign_keys', () => {
    testDb = createTestDb();
    const raw = testDb.app.db;
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('迁移全部应用，且 schema_migrations 记录正确', () => {
    testDb = createTestDb();
    expect(testDb.app.appliedVersions()).toEqual([1, 2, 3, 4, 5, 6]);
    const row = testDb.app.db
      .prepare('SELECT name FROM schema_migrations WHERE version = 1')
      .get() as { name: string };
    expect(row.name).toBe('init');
    const row2 = testDb.app.db
      .prepare('SELECT name FROM schema_migrations WHERE version = 2')
      .get() as { name: string };
    expect(row2.name).toBe('notifications');
    const row3 = testDb.app.db
      .prepare('SELECT name FROM schema_migrations WHERE version = 3')
      .get() as { name: string };
    expect(row3.name).toBe('topic_library');
    const row4 = testDb.app.db
      .prepare('SELECT name FROM schema_migrations WHERE version = 4')
      .get() as { name: string };
    expect(row4.name).toBe('per_account');
    const row5 = testDb.app.db
      .prepare('SELECT name FROM schema_migrations WHERE version = 5')
      .get() as { name: string };
    expect(row5.name).toBe('normalize_account_case');
    const row6 = testDb.app.db
      .prepare('SELECT name FROM schema_migrations WHERE version = 6')
      .get() as { name: string };
    expect(row6.name).toBe('drop_topic_name');
  });

  it('重复打开同一文件幂等，不重复迁移', () => {
    testDb = createTestDb();
    testDb.app.close();
    const reopened = new AppDatabase({ path: testDb.dbPath });
    expect(reopened.appliedVersions()).toEqual([1, 2, 3, 4, 5, 6]);
    reopened.close();
    testDb = null; // 目录清理在 afterEach 中执行
  });

  it('全部核心表存在', () => {
    testDb = createTestDb();
    const tables = (
      testDb.app.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const expected of [
      'watched_accounts',
      'tweets',
      'translations',
      'bili_topics',
      'publish_records',
      'qq_messages',
      'qq_notifications',
      'schema_migrations',
    ]) {
      expect(tables).toContain(expected);
    }
  });
});
