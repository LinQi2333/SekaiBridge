import 'dotenv/config';
import { loadConfigFromEnv } from './config/config.js';
import { AppDatabase } from './db/database.js';
import { createRepositories, createServices } from './services/index.js';

/**
 * 应用入口（Phase 1：项目骨架）。
 * 后续阶段依次接入 TweetToaster（P2）、Monitor（P3）、截图与媒体（P4）、
 * 来源检查（P5）、QQ（P6）、翻译/话题/工作流（P7）、Bilibili 发布（P8）。
 */
function main(): void {
  const config = loadConfigFromEnv();
  const database = new AppDatabase({ path: config.databasePath });

  const repos = createRepositories(database.db);
  const services = createServices(repos);

  console.log('[boot] twitter-qq-bilibili Phase 1 scaffold');
  console.log(`[boot] database: ${config.databasePath} (migrations: ${database.appliedVersions().join(',')})`);
  console.log(`[boot] watched accounts: ${services.watch.list().length}`);
  console.log('[boot] ready. 后续阶段: TweetToaster(P2) Monitor(P3) 截图/媒体(P4) 来源检查(P5) QQ(P6) 翻译/话题/工作流(P7) Bilibili(P8)');

  const shutdown = (signal: string): void => {
    console.log(`[boot] received ${signal}, closing...`);
    database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
