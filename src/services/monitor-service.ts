import type { Tweet } from '../domain/tweet.js';
import type { WatchedAccount } from '../domain/watched-account.js';
import { log } from '../logger.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { WatchRepository } from '../repositories/watch-repository.js';
import { toNewTweetInputs } from '../tweettoaster/normalize.js';
import type { ToasterTweetResponse } from '../tweettoaster/types.js';
import { NotFoundError, NotImplementedError } from './errors.js';

/** Monitor 依赖的 timeline 数据源（TweetToasterClient 满足该结构，便于测试注入 mock）。 */
export interface TimelineSource {
  getTimeline(screenName: string): Promise<ToasterTweetResponse>;
}

/** 单个账户一轮轮询的结果。 */
export interface MonitorPollResult {
  screenName: string;
  mode: 'bootstrap' | 'incremental';
  /** timeline 返回的推文数。 */
  timelineCount: number;
  /** 本轮新检测到的推文（bootstrap 阶段恒为空，规格 §7 不通知）。 */
  newTweets: Tweet[];
  /** 已存在（重复）的推文数。 */
  duplicateCount: number;
  /** 本轮错误信息；null 表示成功。 */
  error: string | null;
}

export interface MonitorOptions {
  watch: WatchRepository;
  tweets: TweetRepository;
  tweetToaster: TimelineSource;
  /** 轮询间隔（毫秒），来自 TWITTER_POLL_INTERVAL。 */
  pollIntervalMs: number;
  /** 每账户轮询 jitter（毫秒，±），默认 10000（规格 §6 ±10 秒）。 */
  jitterMs?: number;
  /** 增量检测到新推文时的回调（Phase 6 在此发送 QQ 通知）；支持异步。 */
  onNewTweets?: (tweets: Tweet[]) => void | Promise<void>;
}

/**
 * Twitter 监听（规格 §5 / §6 / §7 / §8）。
 *
 * - 支持 0 / 1 / N 个监听账户（0 个时 Monitor Idle，应用正常运行）；
 * - 每个账户独立轮询，加入 ±jitter 避免请求同时发出；
 * - bootstrap（latest_only）：首次成功读取 timeline 时把已有推文全部写入
 *   seen / tweets，标记 bootstrap 完成，不发送通知，之后只检测新推文；
 * - x_tweet_id 由数据库 UNIQUE 约束去重（规格 §8 / §19）。
 */
export class SqliteMonitorService implements MonitorService {
  private readonly watch: WatchRepository;
  private readonly tweets: TweetRepository;
  private readonly tweetToaster: TimelineSource;
  private readonly pollIntervalMs: number;
  private readonly jitterMs: number;
  private readonly onNewTweets?: (tweets: Tweet[]) => void;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly nextPollAt = new Map<number, number>();

  constructor(options: MonitorOptions) {
    this.watch = options.watch;
    this.tweets = options.tweets;
    this.tweetToaster = options.tweetToaster;
    this.pollIntervalMs = options.pollIntervalMs;
    this.jitterMs = options.jitterMs ?? 10_000;
    this.onNewTweets = options.onNewTweets;
  }

  /** 启动轮询循环；0 个启用账户时保持空闲。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.#scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 手动触发一轮：轮询全部启用账户（测试与调试用）。 */
  async pollOnce(): Promise<MonitorPollResult[]> {
    const results: MonitorPollResult[] = [];
    for (const account of this.watch.list()) {
      if (!account.enabled) continue;
      results.push(await this.pollAccount(account));
    }
    return results;
  }

  /**
   * 立即刷新：指定账号则只刷新该账号，否则刷新全部启用账户。
   * （!刷新 [@账号] 指令后端，规格 §8 手动轮询）
   */
  async refresh(screenName?: string): Promise<MonitorPollResult[]> {
    if (!screenName) {
      return this.pollOnce();
    }
    const account = this.watch.findByScreenName(screenName);
    if (!account) {
      throw new NotFoundError(`账号未在监听: @${screenName}`);
    }
    return [await this.pollAccount(account)];
  }

  /** 轮询单个账户（bootstrap 或增量）。 */
  async pollAccount(account: WatchedAccount): Promise<MonitorPollResult> {
    const mode: 'bootstrap' | 'incremental' = account.bootstrapCompleted ? 'incremental' : 'bootstrap';
    try {
      const response = await this.tweetToaster.getTimeline(account.screenName);
      // 时间线推文统一归属到被监听账号：转推（author 为原作者）也需监听，
      // 转推附加的文字要翻译；无附加文字的后续用空翻译兜底。原始作者保留在 raw_json。
      // 反转后再入库，使本地编号随发布时间递增（最早的 #1、最新的 #N）
      const inputs = toNewTweetInputs(response)
        .map((i) => ({ ...i, authorScreenName: account.screenName }))
        .reverse();
      const result: MonitorPollResult = {
        screenName: account.screenName,
        mode,
        timelineCount: inputs.length,
        newTweets: [],
        duplicateCount: 0,
        error: null,
      };

      const newTweets: Tweet[] = [];
      for (const input of inputs) {
        const { tweet, created } = this.tweets.findOrCreate(input);
        if (created) {
          newTweets.push(tweet);
          log('tweet.detected', `#${tweet.id} @${tweet.authorScreenName} ${tweet.tweetUrl}`);
        } else {
          result.duplicateCount += 1;
          log('tweet.duplicate', `${tweet.xTweetId}`);
        }
      }

      if (mode === 'bootstrap') {
        // 规格 §7：首次读取只写入 seen，不发送通知
        this.watch.setBootstrapCompleted(account.id, true);
        log(
          'monitor.bootstrap.complete',
          `@${account.screenName} 已记录 ${inputs.length} 条已有推文，本轮不发送通知`,
        );
      } else {
        result.newTweets = newTweets;
        if (newTweets.length > 0) {
          log('monitor.new_tweets', `@${account.screenName} 检测到 ${newTweets.length} 条新推文`);
          // await 处理管线（截图/媒体/通知），保证 pollOnce 返回时新推文已处理完
          await this.onNewTweets?.(newTweets);
        }
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('monitor.poll.error', `@${account.screenName}: ${message}`);
      return { ...resultBase(account, mode), error: message };
    }
  }

  #scheduleNext(): void {
    if (!this.running) return;
    const delay = this.#nextDelayMs();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;
      void this.#tick();
    }, Math.max(0, delay));
  }

  #nextDelayMs(): number {
    const now = Date.now();
    let next = Infinity;
    for (const account of this.watch.list()) {
      if (!account.enabled) continue;
      const due = this.nextPollAt.get(account.id) ?? now;
      next = Math.min(next, due);
    }
    // 没有启用账户：保持空闲，间隔后再检查
    return Number.isFinite(next) ? Math.max(0, next - now) : this.pollIntervalMs;
  }

  async #tick(): Promise<void> {
    const now = Date.now();
    for (const account of this.watch.list()) {
      if (!account.enabled) continue;
      const due = this.nextPollAt.get(account.id) ?? now;
      if (due > now) continue;
      await this.pollAccount(account);
      this.nextPollAt.set(account.id, now + this.pollIntervalMs + this.#jitter());
    }
    this.#scheduleNext();
  }

  #jitter(): number {
    if (this.jitterMs === 0) return 0;
    return Math.round((Math.random() * 2 - 1) * this.jitterMs);
  }
}

function resultBase(
  account: WatchedAccount,
  mode: 'bootstrap' | 'incremental',
): Omit<MonitorPollResult, 'error'> {
  return {
    screenName: account.screenName,
    mode,
    timelineCount: 0,
    newTweets: [],
    duplicateCount: 0,
  };
}

/** Twitter 监听接口（规格 §5）。 */
export interface MonitorService {
  start(): void;
  stop(): void;
  pollOnce(): Promise<MonitorPollResult[]>;
  /** 立即刷新：指定账号只刷该账号，否则全部启用账户。 */
  refresh(screenName?: string): Promise<MonitorPollResult[]>;
  isRunning(): boolean;
}

export class StubMonitorService implements MonitorService {
  start(): void {
    throw new NotImplementedError('MonitorService（Phase 3）');
  }

  stop(): void {
    throw new NotImplementedError('MonitorService（Phase 3）');
  }

  pollOnce(): Promise<MonitorPollResult[]> {
    throw new NotImplementedError('MonitorService（Phase 3）');
  }

  refresh(_screenName?: string): Promise<MonitorPollResult[]> {
    throw new NotImplementedError('MonitorService（Phase 3）');
  }

  isRunning(): boolean {
    return false;
  }
}
