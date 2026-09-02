import fs from 'node:fs/promises';
import path from 'node:path';
import type { TweetRepository } from '../repositories/tweet-repository.js';
import type { TweetToasterClient } from '../tweettoaster/client.js';
import { TweetToasterError } from '../tweettoaster/errors.js';
import { safeDownload } from '../media/safe-download.js';
import { NotImplementedError, NotFoundError } from './errors.js';

/**
 * 推文截图（规格 §15 / §47 / §65）。
 * 通过 TweetToaster /api/render 生成"原推截图"（无翻译模板、无 Logo），
 * 下载到本地 cache/screenshots/<tweet-id>.png 持久保存（TweetToaster 缓存会定期清理）。
 * 推文截图 ≠ Twitter 原始图片，两者是不同资产。
 */
export interface ScreenshotService {
  /** 生成截图并保存到 cache/screenshots/<tweet-id>.png，返回本地文件路径。 */
  render(tweetId: number): Promise<string>;
}

export interface ScreenshotServiceOptions {
  tweets: TweetRepository;
  tweetToaster: Pick<TweetToasterClient, 'getTweet' | 'render'>;
  /** 截图缓存目录（cacheRoot/screenshots，绝对路径）。 */
  cacheDir: string;
  /** 缓存根目录（绝对路径）；返回相对该目录的路径便于跨机器部署。 */
  cacheRoot: string;
  fetchImpl?: typeof fetch;
}

export class DefaultScreenshotService implements ScreenshotService {
  private readonly tweets: TweetRepository;
  private readonly tweetToaster: Pick<TweetToasterClient, 'getTweet' | 'render'>;
  private readonly cacheDir: string;
  private readonly cacheRoot: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ScreenshotServiceOptions) {
    this.tweets = options.tweets;
    this.tweetToaster = options.tweetToaster;
    this.cacheDir = options.cacheDir;
    this.cacheRoot = options.cacheRoot;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async render(tweetId: number): Promise<string> {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }

    // 先取焦点推文 id（/api/render 的 selection 必填，规格 §65）
    const response = await this.tweetToaster.getTweet(tweet.tweetUrl);
    const focal =
      response.tweets[response.focalIndex] ?? response.tweets.find((item) => item.focal) ?? null;
    if (!focal) {
      throw new TweetToasterError(`推文 #${tweetId} 没有可渲染的焦点推文`);
    }

    // original-only：空模板、无 Logo、不显示计数（规格 §65）
    const pngUrl = await this.tweetToaster.render({
      tweet: tweet.tweetUrl,
      translate: '',
      template: '',
      logo: 'none',
      noLikes: true,
      selection: [{ id: focal.id }],
    });

    const { bytes } = await safeDownload(pngUrl, {
      fetchImpl: this.fetchImpl,
      allowedContentTypes: ['image/png'],
    });
    await fs.mkdir(this.cacheDir, { recursive: true });
    const filePath = path.join(this.cacheDir, `${tweetId}.png`);
    await fs.writeFile(filePath, bytes);
    // 返回相对 cacheRoot 的路径（正斜杠），保证数据库可跨机器部署
    return toPortablePath(path.relative(this.cacheRoot, filePath));
  }
}

/** 平台分隔符 → 正斜杠（DB 统一存储格式）。 */
export function toPortablePath(p: string): string {
  return p.split(path.sep).join('/');
}

export class StubScreenshotService implements ScreenshotService {
  render(_tweetId: number): Promise<string> {
    throw new NotImplementedError('ScreenshotService 未接线');
  }
}
