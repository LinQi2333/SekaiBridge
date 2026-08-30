import type { Tweet } from '../domain/tweet.js';
import { TweetRepository, type TweetListFilter, type TweetListOptions } from '../repositories/tweet-repository.js';
import { NotFoundError } from './errors.js';

export interface TweetListResult {
  items: Tweet[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 推文查询（规格 §26 / §27）。
 * QQ /列表、/查看 与未来 Web 共用同一查询逻辑。
 */
export interface TweetQueryService {
  getById(id: number): Tweet;
  getByXId(xTweetId: string): Tweet | null;
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

  list(filter: TweetListFilter, options: Omit<TweetListOptions, 'filter'> = {}): TweetListResult {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 20));
    const items = this.tweets.list({ filter, page, pageSize });
    const total = this.tweets.count({ filter });
    return { items, total, page, pageSize };
  }
}
