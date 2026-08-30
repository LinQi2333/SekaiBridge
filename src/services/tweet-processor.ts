import type { Tweet } from '../domain/tweet.js';
import { WorkflowStatus } from '../domain/workflow.js';
import { log } from '../logger.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import type { MediaService } from './media-service.js';
import type { ScreenshotService } from './screenshot-service.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * 新推文处理管线（规格 §1 流程：检测 → 截图 → 媒体处理 → 发送 QQ）。
 * Phase 6 之前先处理到"截图完成"状态；QQ 通知在 Phase 6 接入。
 * 截图失败不阻塞后续推文，记录 lastError 并保持 DETECTED；
 * 媒体缓存失败不回退截图状态。
 */
export interface NewTweetProcessor {
  process(tweets: Tweet[]): Promise<void>;
}

export interface NewTweetProcessorOptions {
  tweets: TweetRepository;
  workflow: WorkflowService;
  screenshot: ScreenshotService;
  media: MediaService;
}

export class DefaultNewTweetProcessor implements NewTweetProcessor {
  private readonly tweets: TweetRepository;
  private readonly workflow: WorkflowService;
  private readonly screenshot: ScreenshotService;
  private readonly media: MediaService;

  constructor(options: NewTweetProcessorOptions) {
    this.tweets = options.tweets;
    this.workflow = options.workflow;
    this.screenshot = options.screenshot;
    this.media = options.media;
  }

  async process(newTweets: Tweet[]): Promise<void> {
    for (const tweet of newTweets) {
      // 1) 推文截图（规格 §15）
      try {
        const screenshotPath = await this.screenshot.render(tweet.id);
        this.tweets.setScreenshotPath(tweet.id, screenshotPath);
        this.workflow.transition(tweet.id, WorkflowStatus.SCREENSHOT_READY);
        log('tweet.screenshot.complete', `#${tweet.id} ${screenshotPath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.DETECTED, { lastError: message });
        log('tweet.screenshot.failed', `#${tweet.id}: ${message}`);
        continue; // 截图失败不再处理媒体
      }

      // 2) 媒体缓存（photo / 视频封面；规格 §17 / §18 / §47）
      try {
        await this.media.cachePhotos(tweet.id);
        await this.media.cacheVideoThumbnails(tweet.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('tweet.media.failed', `#${tweet.id}: ${message}`);
      }
    }
  }
}
