import 'dotenv/config';
import { createApiServer } from './api/server.js';
import { BilibiliClient } from './bilibili/client.js';
import { BilibiliDynamicPublisher } from './bilibili/dynamic-publisher.js';
import { BilibiliImageUploader } from './bilibili/image-upload.js';
import { loadConfigFromEnv } from './config/config.js';
import { AppDatabase } from './db/database.js';
import { createProxyFetch } from './media/proxy-fetch.js';
import { createRepositories, createServices } from './services/index.js';
import { TweetToasterClient } from './tweettoaster/client.js';

/**
 * 应用入口。
 * 已完成：P1 骨架、P2 TweetToaster Client、P3 Monitor、P4 截图/媒体、
 * P5 来源检查、P6 HTTP API（NoneBot2 方案）、P7 翻译/话题/工作流、P8 Bilibili 发布。
 * 后续阶段：完整集成测试（P9）、Docker/部署（P10）。
 */
function main(): void {
  const config = loadConfigFromEnv();
  const database = new AppDatabase({ path: config.databasePath });

  const repos = createRepositories(database.db);
  // 支持 HTTPS_PROXY 的 fetch（国内环境访问 Twitter CDN 需要代理）
  const fetchImpl = createProxyFetch();
  const tweetToaster = new TweetToasterClient({ baseUrl: config.tweettoasterUrl, fetchImpl });
  // Bilibili 是国内服务，必须直连（走代理会因出口 IP 不一致触发 CSRF/风控）
  const biliClient = new BilibiliClient({
    cookie: {
      sessdata: config.biliSessdata,
      jct: config.biliJct,
      dedeuserid: config.biliDedeuserid,
    },
    // 完整 Cookie 串（含 buvid 等指纹）优先，更贴近真实浏览器
    cookieString: config.biliCookieString,
  });
  const services = createServices(repos, {
    config,
    tweetToaster,
    fetchImpl,
    bilibili: {
      imageUploader: new BilibiliImageUploader(biliClient),
      dynamicPublisher: new BilibiliDynamicPublisher(biliClient),
    },
  });

  console.log('[boot] twitter-qq-bilibili (Phase 1-6)');
  console.log(`[boot] database: ${config.databasePath} (migrations: ${database.appliedVersions().join(',')})`);
  console.log(`[boot] watched accounts: ${services.watch.list().length}`);
  console.log(`[boot] tweettoaster: ${config.tweettoasterUrl}`);

  // 监听循环：0 个账户时 Monitor Idle，应用保持运行（规格 §5）
  services.monitor.start();
  console.log('[boot] monitor started');

  // 来源检查循环（SOURCE_CHECK_INTERVAL，规格 §12）
  services.sourceValidation.start();
  console.log('[boot] source validation started');

  // 内部 HTTP API：NoneBot2（连 NapCat）与未来 Web 调用（规格 §2.2）
  const apiServer = createApiServer({
    services,
    config,
    notifications: repos.notifications,
    messageDedupe: repos.messageDedupe,
    tweetToaster,
  });
  apiServer.listen(config.apiPort, () => {
    console.log(`[boot] api listening on http://127.0.0.1:${config.apiPort}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[boot] received ${signal}, closing...`);
    services.monitor.stop();
    services.sourceValidation.stop();
    apiServer.close();
    database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
