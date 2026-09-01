import type { BiliTopic, NewBiliTopicInput } from '../domain/topic.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { AlreadyExistsError, NotFoundError } from './errors.js';

/**
 * Bilibili 话题库（规格 §31）。
 * 话题库维护 别名 ↔ B站话题号 映射；推文不单独绑定话题，
 * 发布时通过 !发布 <编号> <别名> 按别名从库中取话题。
 */
export interface TopicService {
  list(): BiliTopic[];
  /** 添加话题到库（别名 + B站话题号）。 */
  createTopic(input: NewBiliTopicInput): BiliTopic;
  getByAlias(alias: string): BiliTopic | null;
  /** 按别名从库中移除；不存在抛 NotFoundError。 */
  removeTopic(alias: string): boolean;
}

export class SqliteTopicService implements TopicService {
  constructor(private readonly topics: TopicRepository) {}

  list(): BiliTopic[] {
    return this.topics.list(true);
  }

  createTopic(input: NewBiliTopicInput): BiliTopic {
    const alias = normalizeAlias(input.alias);
    if (this.topics.findByAlias(alias)) {
      throw new AlreadyExistsError(`话题别名已存在: ${alias}`);
    }
    const biliTopicId = input.biliTopicId.trim();
    if (this.topics.findByBiliTopicId(biliTopicId)) {
      throw new AlreadyExistsError(`B站话题号已存在: ${biliTopicId}`);
    }
    return this.topics.create({ alias, biliTopicId });
  }

  getByAlias(alias: string): BiliTopic | null {
    return this.topics.findByAlias(normalizeAlias(alias));
  }

  removeTopic(alias: string): boolean {
    const normalized = normalizeAlias(alias);
    if (!this.topics.removeByAlias(normalized)) {
      throw new NotFoundError(`话题不存在: ${normalized}`);
    }
    return true;
  }
}

export function normalizeAlias(raw: string): string {
  return raw.trim().toLowerCase();
}
