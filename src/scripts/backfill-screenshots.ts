// 历史推文补截图脚本：为所有没有截图的推文生成推文截图。
// 用法：node dist/scripts/backfill-screenshots.js [limit]
// 说明：bootstrap 首次监听的历史推文没有截图（规格 §7 不处理历史），
// 运行本脚本后 /查看 与列表均可展示截图。
import path from 'node:path';
import { createProxyFetch } from '../media/proxy-fetch.js';
import { AppDatabase } from '../db/database.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { DefaultScreenshotService } from '../services/screenshot-service.js';
import { SqliteWorkflowService } from '../services/workflow-service.js';
import { TweetToasterClient } from '../tweettoaster/client.js';
import { WorkflowStatus } from '../domain/workflow.js';
import { log } from '../logger.js';

const limit = Number(process.argv[2] ?? 100);
const db = new AppDatabase({ path: process.env.DATABASE_PATH ?? 'data/app.db' });
const tweets = new TweetRepository(db.db);
const fetchImpl = createProxyFetch();
const client = new TweetToasterClient({
  baseUrl: process.env.TWEETTOASTER_URL ?? 'http://127.0.0.1:8082',
  fetchImpl,
});
// 缓存根目录（绝对路径用于写文件；服务返回相对路径便于跨机器部署）
const cacheRoot = path.resolve(process.env.CACHE_ROOT ?? 'cache');
const screenshot = new DefaultScreenshotService({
  tweets,
  tweetToaster: client,
  cacheDir: path.join(cacheRoot, 'screenshots'),
  cacheRoot,
  fetchImpl,
});
const workflow = new SqliteWorkflowService(tweets);

const due = tweets.listWithoutScreenshot(limit);
console.log(`待补截图推文: ${due.length} 条`);
let ok = 0;
let failed = 0;
for (const tweet of due) {
  try {
    const path = await screenshot.render(tweet.id);
    tweets.setScreenshotPath(tweet.id, path);
    // DETECTED → SCREENSHOT_READY；其他状态只补截图不转状态
    if (tweet.workflowStatus === WorkflowStatus.DETECTED) {
      workflow.transition(tweet.id, WorkflowStatus.SCREENSHOT_READY);
    }
    log('tweet.screenshot.backfilled', `#${tweet.id} ${path}`);
    ok += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('tweet.screenshot.backfill_failed', `#${tweet.id}: ${message}`);
    failed += 1;
  }
}
console.log(`完成: 成功 ${ok} 条, 失败 ${failed} 条`);
db.close();
