import { SourceStatus } from '../domain/workflow.js';
import { log } from '../logger.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { TweetNotFoundError } from '../tweettoaster/errors.js';
import { NotFoundError, NotImplementedError } from './errors.js';

/** 来源检查依赖的单推数据源（TweetToasterClient 满足该结构）。 */
export interface SingleTweetSource {
  getTweet(url: string): Promise<unknown>;
}

/**
 * 来源检查（规格 §12 / §13 / §50）。
 *
 * 绝不因"timeline 中消失"判定删除（timeline 有长度限制，not in timeline != deleted）。
 * 只有单推检查 getTweet() 明确返回 404 / tombstone / not found 时才设置
 * source_status = SOURCE_DELETED。
 *
 * 删除后：本地记录、截图、媒体、翻译、话题、发布记录全部保留，
 * 不自动删除任务 / 取消翻译 / 删除 Bilibili 动态（§13）。
 */
export interface SourceValidationService {
  /** 检查一批待检查推文，返回本次标记为 SOURCE_DELETED 的推文 id。 */
  checkDue(): Promise<number[]>;
  /** 对单条推文立即刷新检查（/查看 时使用）；返回是否已标记为删除。 */
  checkTweet(tweetId: number): Promise<boolean>;
  /** 按 SOURCE_CHECK_INTERVAL 周期检查（0 账户外始终可用）。 */
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export interface SourceValidationOptions {
  tweets: TweetRepository;
  tweetToaster: SingleTweetSource;
  /** 检查间隔（毫秒），来自 SOURCE_CHECK_INTERVAL。 */
  checkIntervalMs: number;
  /** 新标记为 SOURCE_DELETED 时的回调（Phase 6 可在此通知 QQ）。 */
  onDeleted?: (tweetIds: number[]) => void;
}

export class DefaultSourceValidationService implements SourceValidationService {
  private readonly tweets: TweetRepository;
  private readonly tweetToaster: SingleTweetSource;
  private readonly checkIntervalMs: number;
  private readonly onDeleted?: (tweetIds: number[]) => void;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private checking = false;

  constructor(options: SourceValidationOptions) {
    this.tweets = options.tweets;
    this.tweetToaster = options.tweetToaster;
    this.checkIntervalMs = options.checkIntervalMs;
    this.onDeleted = options.onDeleted;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.#run(), this.checkIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async checkDue(): Promise<number[]> {
    const due = this.tweets.listForSourceCheck();
    const deleted: number[] = [];
    for (const tweet of due) {
      if (await this.checkTweet(tweet.id)) {
        deleted.push(tweet.id);
      }
    }
    return deleted;
  }

  async checkTweet(tweetId: number): Promise<boolean> {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    if (tweet.sourceStatus === SourceStatus.SOURCE_DELETED) {
      return true; // 已经是删除状态
    }
    try {
      await this.tweetToaster.getTweet(tweet.tweetUrl);
      log('tweet.source.active', `#${tweet.id} 原推仍可访问`);
      return false;
    } catch (error) {
      if (error instanceof TweetNotFoundError) {
        this.tweets.setSourceStatus(tweetId, SourceStatus.SOURCE_DELETED);
        log('tweet.source.deleted', `#${tweet.id} ${tweet.tweetUrl}`);
        this.onDeleted?.([tweetId]);
        return true;
      }
      // 网络 / Provider 不可用等：不标记删除（规格 §12：必须明确确认）
      const message = error instanceof Error ? error.message : String(error);
      log('tweet.source.check.error', `#${tweet.id}: ${message}`);
      return false;
    }
  }

  #run(): void {
    if (this.checking) return; // 防止上一轮未结束时重叠
    this.checking = true;
    this.checkDue()
      .catch((error) => log('tweet.source.check.failed', String(error)))
      .finally(() => {
        this.checking = false;
      });
  }
}

export class StubSourceValidationService implements SourceValidationService {
  checkDue(): Promise<number[]> {
    throw new NotImplementedError('SourceValidationService（Phase 5）');
  }

  checkTweet(_tweetId: number): Promise<boolean> {
    throw new NotImplementedError('SourceValidationService（Phase 5）');
  }

  start(): void {
    throw new NotImplementedError('SourceValidationService（Phase 5）');
  }

  stop(): void {
    throw new NotImplementedError('SourceValidationService（Phase 5）');
  }

  isRunning(): boolean {
    return false;
  }
}
