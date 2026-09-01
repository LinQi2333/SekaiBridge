import type { Tweet } from '../domain/tweet.js';
import { TweetRepository, type TweetListFilter, type TweetListOptions } from '../repositories/tweet-repository.js';
import { NotFoundError } from './errors.js';

export interface TweetListResult {
  items: Tweet[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TweetManyResult {
  /** 按请求顺序返回找到的推文。 */
  tweets: Tweet[];
  /** 未找到的本地编号。 */
  missing: number[];
}

/**
 * 推文查询（规格 §26 / §27）。
 * 多账号下编号为账号内独立编号（seq）：列表按账号过滤，
 * 未指定账号时由 API 层解析默认账号。
 */
export interface TweetQueryService {
  getById(id: number): Tweet;
  getByXId(xTweetId: string): Tweet | null;
  /** 按账号内编号查找。 */
  getByAccountAndSeq(screenName: string, seq: number): Tweet;
  /** 多条查看（内部全局 id）。 */
  getManyByIds(ids: number[]): TweetManyResult;
  list(filter: TweetListFilter, options?: Omit<TweetListOptions, 'filter'>): TweetListResult;
}

export class SqliteTweetQueryService implements TweetQueryService {
  constructor(private readonly tweets: TweetRepository) {}

  getById(id: number): Tweet {
    const tweet = this.tweets.findById(id);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${id}`);
    }
    return tweet;
  }

  getByXId(xTweetId: string): Tweet | null {
    return this.tweets.findByXId(xTweetId);
  }

  getByAccountAndSeq(screenName: string, seq: number): Tweet {
    const tweet = this.tweets.findByAccountAndSeq(screenName, seq);
    if (!tweet) {
      throw new NotFoundError(`@${screenName} 没有 #${seq} 号推文`);
    }
    return tweet;
  }

  getManyByIds(ids: number[]): TweetManyResult {
    const found: Tweet[] = [];
    const missing: number[] = [];
    for (const id of ids) {
      const tweet = this.tweets.findById(id);
      if (tweet) {
        found.push(tweet);
      } else {
        missing.push(id);
      }
    }
    return { tweets: found, missing };
  }

  list(filter: TweetListFilter, options: Omit<TweetListOptions, 'filter'> = {}): TweetListResult {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 20));
    const items = this.tweets.list({ filter, page, pageSize, account: options.account });
    const total = this.tweets.count({ filter, account: options.account });
    return { items, total, page, pageSize };
  }
}
