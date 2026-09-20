import type { Tweet } from '../domain/tweet.js';
import { WorkflowStatus } from '../domain/workflow.js';
import { log } from '../logger.js';
import { formatNewTweetNotification } from '../qq/format.js';
import { NotificationRepository } from '../repositories/notification-repository.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import type { MediaLibrary } from './media-library.js';
import type { ScreenshotService } from './screenshot-service.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * 新推文处理管线（检测 → 截图 → QQ 通知 → 媒体下载）。
 * - 截图失败不阻塞后续推文：记录 lastError 并保持 DETECTED
 * - 先发通知再下载媒体：视频体积较大，避免通知被拖慢
 * - 媒体下载失败只记日志，不影响通知与工作流状态
 */
export interface NewTweetProcessor {
  process(tweets: Tweet[]): Promise<void>;
  retryFailedScreenshots(): Promise<void>;
}

export interface NewTweetProcessorOptions {
  tweets: TweetRepository;
  workflow: WorkflowService;
  screenshot: ScreenshotService;
  media: MediaLibrary;
  /** 传入后：截图完成后生成 QQ 通知记录（NoneBot2 拉取发送）。 */
  notifications?: NotificationRepository;
}

export class DefaultNewTweetProcessor implements NewTweetProcessor {
  private readonly tweets: TweetRepository;
  private readonly workflow: WorkflowService;
  private readonly screenshot: ScreenshotService;
  private readonly media: MediaLibrary;
  private readonly notifications?: NotificationRepository;
  private readonly processing = new Set<number>();

  constructor(options: NewTweetProcessorOptions) {
    this.tweets = options.tweets;
    this.workflow = options.workflow;
    this.screenshot = options.screenshot;
    this.media = options.media;
    this.notifications = options.notifications;
  }

  async process(newTweets: Tweet[]): Promise<void> {
    for (const tweet of newTweets) {
      const current = this.tweets.findById(tweet.id);
      if (!current || current.screenshotPath || this.processing.has(tweet.id)) continue;
      this.processing.add(tweet.id);
      try {
        await this.#processTweet(tweet);
      } finally {
        this.processing.delete(tweet.id);
      }
    }
  }

  async retryFailedScreenshots(): Promise<void> {
    await this.process(this.tweets.listScreenshotRetries());
  }

  async #processTweet(tweet: Tweet): Promise<void> {
    // 1) 推文截图
    try {
      const screenshotPath = await this.screenshot.render(tweet.id);
      this.tweets.setScreenshotPath(tweet.id, screenshotPath);
      const current = this.tweets.findById(tweet.id);
      if (current?.workflowStatus === WorkflowStatus.DETECTED) {
        this.workflow.transition(tweet.id, WorkflowStatus.SCREENSHOT_READY, { lastError: null, retryCount: 0 });
      }
      log('tweet.screenshot.complete', `#${tweet.id} ${screenshotPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.tweets.findById(tweet.id);
      if (current?.workflowStatus === WorkflowStatus.DETECTED) {
        this.tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.DETECTED, {
          lastError: message, retryCount: current.retryCount + 1,
        });
      }
      log('tweet.screenshot.failed', `#${tweet.id}: ${message}`);
      return; // 后台定时重试，不依赖该推文仍在时间线中
    }

    // 2) 生成 QQ 通知记录（NoneBot2 拉取发送）
    if (this.notifications) {
      try {
        const updated = this.tweets.findById(tweet.id);
        if (updated) {
          this.notifications.create({
            tweetId: tweet.id,
            text: formatNewTweetNotification(updated),
            screenshotPath: updated.screenshotPath,
            videoThumbnails: [],
          });
          log('qq.notification.created', `#${tweet.id}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('qq.notification.failed', `#${tweet.id}: ${message}`);
      }
    }

    // 3) 媒体下载（图片 name=orig + 最高码率视频），统一存入 cache/media/<推文ID>/
    try {
      await this.media.cacheMedia(tweet.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('tweet.media.failed', `#${tweet.id}: ${message}`);
    }
  }
}
