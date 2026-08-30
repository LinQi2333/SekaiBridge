import type { BiliTopic, NewBiliTopicInput } from '../domain/topic.js';
import type { Tweet } from '../domain/tweet.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { AlreadyExistsError, NotFoundError } from './errors.js';

/**
 * Bilibili 话题（规格 §31 / §32）。
 * 话题别名在群内使用；"无"表示清除话题。
 */
export interface TopicService {
  list(): BiliTopic[];
  createTopic(input: NewBiliTopicInput): BiliTopic;
  getByAlias(alias: string): BiliTopic | null;
  /** 给推文设置话题；alias 为 null 时清除。 */
  setTopic(tweetId: number, alias: string | null): Tweet;
}

export class SqliteTopicService implements TopicService {
  constructor(
    private readonly topics: TopicRepository,
    private readonly tweets: TweetRepository,
  ) {}

  list(): BiliTopic[] {
    return this.topics.list(true);
  }

  createTopic(input: NewBiliTopicInput): BiliTopic {
    const alias = normalizeAlias(input.alias);
    if (this.topics.findByAlias(alias)) {
      throw new AlreadyExistsError(`话题别名已存在: ${alias}`);
    }
    return this.topics.create({ ...input, alias });
  }

  getByAlias(alias: string): BiliTopic | null {
    return this.topics.findByAlias(normalizeAlias(alias));
  }

  setTopic(tweetId: number, alias: string | null): Tweet {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    if (alias === null) {
      return this.tweets.setTopicAlias(tweetId, null) as Tweet;
    }
    const normalized = normalizeAlias(alias);
    const topic = this.topics.findByAlias(normalized);
    if (!topic) {
      throw new NotFoundError(`话题不存在: ${normalized}`);
    }
    if (!topic.enabled) {
      throw new NotFoundError(`话题已停用: ${normalized}`);
    }
    return this.tweets.setTopicAlias(tweetId, normalized) as Tweet;
  }
}

export function normalizeAlias(raw: string): string {
  return raw.trim().toLowerCase();
}
