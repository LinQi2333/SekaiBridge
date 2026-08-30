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
 * QQ /列表、/查看 与未来 Web 共用同一查询逻辑。
 */
export interface TweetQueryService {
  getById(id: number): Tweet;
  getByXId(xTweetId: string): Tweet | null;
  /** 多条查看（规格 §27：/查看 152 155 160）。 */
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
    const items = this.tweets.list({ filter, page, pageSize });
    const total = this.tweets.count({ filter });
    return { items, total, page, pageSize };
  }
}
