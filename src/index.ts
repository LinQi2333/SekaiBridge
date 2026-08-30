import 'dotenv/config';
import { loadConfigFromEnv } from './config/config.js';
import { AppDatabase } from './db/database.js';
import { createRepositories, createServices } from './services/index.js';
import { TweetToasterClient } from './tweettoaster/client.js';

/**
 * 应用入口。
 * 已完成：P1 骨架、P2 TweetToaster Client、P3 Monitor。
 * 后续阶段：截图/媒体（P4）、来源检查（P5）、QQ（P6）、翻译/话题/工作流（P7）、
 * Bilibili 发布（P8）、集成测试（P9）、Docker/部署（P10）。
 */
function main(): void {
  const config = loadConfigFromEnv();
  const database = new AppDatabase({ path: config.databasePath });

  const repos = createRepositories(database.db);
  const tweetToaster = new TweetToasterClient({ baseUrl: config.tweettoasterUrl });
  const services = createServices(repos, { config, tweetToaster });

  console.log('[boot] twitter-qq-bilibili (Phase 1-3)');
  console.log(`[boot] database: ${config.databasePath} (migrations: ${database.appliedVersions().join(',')})`);
  console.log(`[boot] watched accounts: ${services.watch.list().length}`);
  console.log(`[boot] tweettoaster: ${config.tweettoasterUrl}`);

  // 监听循环：0 个账户时 Monitor Idle，应用保持运行（规格 §5）
  services.monitor.start();
  console.log('[boot] monitor started');

  // 来源检查循环（SOURCE_CHECK_INTERVAL，规格 §12）
  services.sourceValidation.start();
  console.log('[boot] source validation started');

  const shutdown = (signal: string): void => {
    console.log(`[boot] received ${signal}, closing...`);
    services.monitor.stop();
    services.sourceValidation.stop();
    database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
