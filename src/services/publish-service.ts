import type { PublishRecord } from '../domain/publish.js';
import { NotImplementedError } from './errors.js';

export interface PublishResult {
  /** 是否为新发布；false 表示幂等命中（已发布）。 */
  published: boolean;
  record: PublishRecord;
}

/**
 * Bilibili 发布（规格 §33 / §34 / §35 / §36 / §37 / §38 / §39）—— Phase 8 实现。
 * 职责：读取 tweet + 最新翻译 + 话题，筛选 photo 上传，发布动态，记录结果。
 * QQ /发布 与未来 Web 都调用同一个 publish()。
 */
export interface PublishService {
  /** 发布推文；已发布（PUBLISHED）时幂等返回，不重复调用 Bilibili API。 */
  publish(tweetId: number, topicAlias?: string): Promise<PublishResult>;
  /** 该推文是否已成功发布。 */
  isPublished(tweetId: number): boolean;
}

export class StubPublishService implements PublishService {
  publish(_tweetId: number, _topicAlias?: string): Promise<PublishResult> {
    throw new NotImplementedError('PublishService（Phase 8）');
  }

  isPublished(_tweetId: number): boolean {
    throw new NotImplementedError('PublishService（Phase 8）');
  }
}
