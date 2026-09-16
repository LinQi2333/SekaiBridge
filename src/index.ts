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
 * 应用入口：启动数据库、监听/截图/来源检查服务、内部 HTTP API，
 * 以及 Bilibili 会话体检与 bili_ticket / SESSDATA 自动续期。
 */
const BILI_LOGIN_HINT =
  'docker compose stop app && docker compose --profile tools run --rm --service-ports bili-login && docker compose up -d app';

function main(): void {
  const config = loadConfigFromEnv();
  const database = new AppDatabase({ path: config.databasePath });

  const repos = createRepositories(database.db);
  // 支持 HTTPS_PROXY 的 fetch（国内环境访问 Twitter CDN 需要代理）
  const fetchImpl = createProxyFetch();
  const tweetToaster = new TweetToasterClient({ baseUrl: config.tweettoasterUrl, fetchImpl });
  // Bilibili 是国内服务，必须直连（走代理会因出口 IP 不一致触发 CSRF/风控）
  // 凭据唯一来源：数据目录下的 bili-cookies.json（由扫码登录工具写入，续期时回写）
  const biliClient = new BilibiliClient({ cookieFile: config.biliCookieFile });
  const services = createServices(repos, {
    config,
    tweetToaster,
    fetchImpl,
    bilibili: {
      imageUploader: new BilibiliImageUploader(biliClient),
      dynamicPublisher: new BilibiliDynamicPublisher(biliClient),
    },
  });

  console.log('[boot] sekai-bridge');
  console.log(`[boot] database: ${config.databasePath} (migrations: ${database.appliedVersions().join(',')})`);
  console.log(`[boot] watched accounts: ${services.watch.list().length}`);
  console.log(`[boot] tweettoaster: ${config.tweettoasterUrl}`);

  // 监听循环：0 个账户时 Monitor Idle，应用保持运行（规格 §5）
  services.monitor.start();
  console.log('[boot] monitor started');

  // 来源检查循环（SOURCE_CHECK_INTERVAL，规格 §12）
  services.sourceValidation.start();
  console.log('[boot] source validation started');

  // Bilibili 会话体检 + bili_ticket 自动续期（每 6 小时；SESSDATA 失效前预警）
  const COOKIE_MAINTENANCE_MS = 6 * 60 * 60 * 1000;
  const biliMaintenance = async (): Promise<void> => {
    if (!biliClient.hasCookie()) return;
    try {
      const session = await biliClient.checkSession();
      if (!session.loggedIn) {
        console.error(
          `[bilibili] ⚠️ B站会话已失效（未登录）。请重新扫码登录：${BILI_LOGIN_HINT}`,
        );
        return;
      }
      if (session.refreshNeeded) {
        // B 站提示 SESSDATA 临近过期：有刷新口令就自动续期，否则只能重新扫码
        if (!biliClient.canRefreshCookie()) {
          console.error(
            `[bilibili] ⚠️ B站提示会话需要刷新（SESSDATA 临近过期），但凭据文件里没有刷新口令。请重新扫码登录：${BILI_LOGIN_HINT}`,
          );
        } else {
          const refresh = await biliClient.refreshLoginCookie();
          if (refresh.refreshed) {
            const until = refresh.sessdataExpiresAt
              ? `，有效期至 ${new Date(refresh.sessdataExpiresAt).toISOString()}`
              : '';
            console.log(`[bilibili] SESSDATA 已自动续期${until}（新 Cookie 与刷新口令已写回文件）`);
          } else {
            console.error(
              `[bilibili] ⚠️ SESSDATA 自动续期失败：${refresh.reason}。请重新扫码登录：${BILI_LOGIN_HINT}`,
            );
          }
        }
      }
      const ticket = await biliClient.refreshTicket();
      if (ticket) {
        console.log(
          `[bilibili] bili_ticket 已自动续期（有效期至 ${new Date(ticket.expiresAt * 1000).toISOString()}）`,
        );
      } else {
        console.error('[bilibili] bili_ticket 续期失败（保留旧值，不影响当前会话）');
      }
    } catch (error) {
      console.error(
        '[bilibili] cookie 体检异常:',
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  void biliMaintenance();
  const cookieTimer = setInterval(() => void biliMaintenance(), COOKIE_MAINTENANCE_MS);
  cookieTimer.unref?.();
  console.log('[boot] bilibili cookie maintenance started (every 6h)');

  // 媒体缓存清理（MEDIA_CACHE_TTL_DAYS，默认 7 天；截图永久保留）
  const mediaCleanup = async (): Promise<void> => {
    try {
      const removed = await services.media.cleanupOlderThan(config.mediaCacheTtlDays);
      console.log(
        `[media] 清理完成：删除 ${removed.files} 个文件、${removed.dirs} 个空目录（阈值 ${config.mediaCacheTtlDays} 天）`,
      );
    } catch (error) {
      console.error('[media] 清理失败:', error instanceof Error ? error.message : String(error));
    }
  };
  void mediaCleanup();
  const mediaTimer = setInterval(() => void mediaCleanup(), COOKIE_MAINTENANCE_MS);
  mediaTimer.unref?.();
  console.log(`[boot] media cache cleanup started (keep ${config.mediaCacheTtlDays}d, every 6h)`);

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
    clearInterval(cookieTimer);
    clearInterval(mediaTimer);
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
