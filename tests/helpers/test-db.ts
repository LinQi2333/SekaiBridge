import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../../src/db/database.js';

export interface TestDb {
  app: AppDatabase;
  dir: string;
  dbPath: string;
}

/** 创建临时文件型测试数据库（自动迁移）。 */
export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-test-'));
  const dbPath = path.join(dir, 'test.db');
  const app = new AppDatabase({ path: dbPath });
  return { app, dir, dbPath };
}

/** 关闭并删除临时目录。 */
export function closeTestDb(t: TestDb): void {
  try {
    t.app.close();
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
}
