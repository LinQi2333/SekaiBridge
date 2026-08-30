import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tweet } from '../domain/tweet.js';
import { parseMedia, photoMedia } from '../domain/tweet.js';
import { EXT_BY_CONTENT_TYPE, safeDownload, type SafeDownloadOptions } from '../media/safe-download.js';
import type { TweetRepository } from '../repositories/tweet-repository.js';
import { NotImplementedError, NotFoundError } from './errors.js';

/**
 * 媒体处理（规格 §16 / §18 / §20 / §21 / §47 / §48）。
 * 三种资产严格分离（规格 §47）：
 * - cache/screenshots/<tweet-id>.png        推文截图（ScreenshotService 负责）
 * - cache/twitter-photos/<tweet-id>/<i>.<ext>   Twitter 原始 photo（Bilibili 发布用）
 * - cache/video-thumbnails/<tweet-id>/<i>.<ext> 视频默认封面（QQ 通知用）
 * 视频只下载默认封面，绝不下载视频本体（规格 §18 / §20）。
 */
export interface MediaService {
  /** 缓存推文的 photo 媒体，返回缓存文件路径列表。 */
  cachePhotos(tweetId: number): Promise<string[]>;
  /** 缓存推文视频的默认封面（不下载视频本体），返回封面路径列表。 */
  cacheVideoThumbnails(tweetId: number): Promise<string[]>;
}

export interface MediaServiceOptions {
  tweets: TweetRepository;
  /** 缓存根目录（cacheRoot）。 */
  cacheRoot: string;
  fetchImpl?: typeof fetch;
}

export class DefaultMediaService implements MediaService {
  private readonly tweets: TweetRepository;
  private readonly cacheRoot: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MediaServiceOptions) {
    this.tweets = options.tweets;
    this.cacheRoot = options.cacheRoot;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async cachePhotos(tweetId: number): Promise<string[]> {
    const tweet = this.requireTweet(tweetId);
    const media = photoMedia(tweet); // 只缓存 photo（规格 §21），视频封面不进入
    return this.downloadMedia(tweet, media, 'twitter-photos');
  }

  async cacheVideoThumbnails(tweetId: number): Promise<string[]> {
    const tweet = this.requireTweet(tweetId);
    const media = parseMedia(tweet.mediaJson).filter(
      (item) => item.type === 'video' || item.type === 'gif',
    );
    return this.downloadMedia(tweet, media, 'video-thumbnails');
  }

  private requireTweet(tweetId: number): Tweet {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    return tweet;
  }

  private async downloadMedia(
    tweet: Tweet,
    media: { type: string; url: string }[],
    subdir: string,
  ): Promise<string[]> {
    if (media.length === 0) {
      return [];
    }
    const dir = path.join(this.cacheRoot, subdir, String(tweet.id));
    await fs.mkdir(dir, { recursive: true });

    const options: SafeDownloadOptions = { fetchImpl: this.fetchImpl };
    const paths: string[] = [];
    for (const [index, item] of media.entries()) {
      if (!item.url) continue;
      const { bytes, contentType } = await safeDownload(item.url, options);
      const ext = EXT_BY_CONTENT_TYPE[contentType] ?? 'img';
      const filePath = path.join(dir, `${index}.${ext}`);
      await fs.writeFile(filePath, bytes);
      paths.push(filePath);
    }
    return paths;
  }
}

export class StubMediaService implements MediaService {
  cachePhotos(_tweetId: number): Promise<string[]> {
    throw new NotImplementedError('MediaService（Phase 4）');
  }

  cacheVideoThumbnails(_tweetId: number): Promise<string[]> {
    throw new NotImplementedError('MediaService（Phase 4）');
  }
}
