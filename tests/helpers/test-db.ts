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

/** 关闭并删除临时目录（Windows 上 WAL 文件可能短暂占用，重试几次）。 */
export function closeTestDb(t: TestDb): void {
  try {
    t.app.close();
  } finally {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(t.dir, { recursive: true, force: true });
        return;
      } catch {
        // WAL/SHM 文件句柄释放有延迟，稍等重试
        const start = Date.now();
        while (Date.now() - start < 20) {
          // busy wait 20ms
        }
      }
    }
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
}
