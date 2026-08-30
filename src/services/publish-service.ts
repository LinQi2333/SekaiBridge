import path from 'node:path';
import type { ImageUploader } from '../bilibili/image-upload.js';
import type { DynamicPublisher } from '../bilibili/dynamic-publisher.js';
import { PublishStatus, type PublishRecord } from '../domain/publish.js';
import { photoMedia } from '../domain/tweet.js';
import { WorkflowStatus } from '../domain/workflow.js';
import { EXT_BY_CONTENT_TYPE, safeDownload } from '../media/safe-download.js';
import type { MediaFetcher } from '../media/media-fetcher.js';
import { PublishRepository } from '../repositories/publish-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { TranslationRepository } from '../repositories/translation-repository.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { log } from '../logger.js';
import { NotFoundError, NotImplementedError, ValidationError } from './errors.js';
import type { WorkflowService } from './workflow-service.js';

export interface PublishResult {
  /** 是否为新发布；false 表示幂等命中（已发布）。 */
  published: boolean;
  record: PublishRecord;
}

/**
 * Bilibili 发布（规格 §33 / §34 / §35 / §36 / §37 / §38 / §39）。
 * 职责：读取 tweet + 最新翻译 + 话题，筛选 photo 上传，发布动态，记录结果。
 * QQ /发布 与未来 Web 都调用同一个 publish()。
 */
export interface PublishService {
  /** 发布推文；已发布（PUBLISHED）时幂等返回，不重复调用 Bilibili API（§38）。 */
  publish(tweetId: number, topicAlias?: string): Promise<PublishResult>;
  /** 该推文是否已成功发布。 */
  isPublished(tweetId: number): boolean;
}

export interface DefaultPublishServiceOptions {
  tweets: TweetRepository;
  translations: TranslationRepository;
  topics: TopicRepository;
  publishes: PublishRepository;
  workflow: WorkflowService;
  imageUploader: ImageUploader;
  dynamicPublisher: DynamicPublisher;
  /** 发布时下载 Twitter 原图用（测试注入 mock fetch）。 */
  fetchImpl?: typeof fetch;
  /** 媒体获取策略（默认直连 safeDownload；容器接线时走 TweetToaster 代理）。 */
  fetcher?: MediaFetcher;
}

export class DefaultPublishService implements PublishService {
  private readonly tweets: TweetRepository;
  private readonly translations: TranslationRepository;
  private readonly topics: TopicRepository;
  private readonly publishes: PublishRepository;
  private readonly workflow: WorkflowService;
  private readonly imageUploader: ImageUploader;
  private readonly dynamicPublisher: DynamicPublisher;
  private readonly fetchImpl: typeof fetch;
  private readonly fetcher: MediaFetcher;

  constructor(options: DefaultPublishServiceOptions) {
    this.tweets = options.tweets;
    this.translations = options.translations;
    this.topics = options.topics;
    this.publishes = options.publishes;
    this.workflow = options.workflow;
    this.imageUploader = options.imageUploader;
    this.dynamicPublisher = options.dynamicPublisher;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.fetcher =
      options.fetcher ??
      (async (url) => {
        const result = await safeDownload(url, { fetchImpl: this.fetchImpl });
        return { bytes: result.bytes, contentType: result.contentType };
      });
  }

  async publish(tweetId: number, topicAlias?: string): Promise<PublishResult> {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }

    // 幂等（§38）：已成功发布 → 不调用 Bilibili API
    const existing = this.publishes.findSuccessfulByTweet(tweetId);
    if (existing) {
      log('bilibili.publish.idempotent', `#${tweetId} 已发布，跳过`);
      return { published: false, record: existing };
    }
    if (tweet.workflowStatus === WorkflowStatus.PUBLISHED) {
      throw new ValidationError(`#${tweetId} 已处于已发布状态但没有成功记录，请检查数据`);
    }

    // 发布内容 = 最终翻译文本（§34）
    const translation = this.translations.findLatest(tweetId);
    if (!translation) {
      throw new ValidationError(`#${tweetId} 还没有翻译，请先提交翻译`);
    }

    // 话题：参数优先，否则使用已保存话题（§33）
    const alias = topicAlias ?? tweet.topicAlias;
    let topicId: string | null = null;
    if (alias) {
      const topic = this.topics.findByAlias(alias);
      if (!topic) {
        throw new ValidationError(`话题不存在: ${alias}`);
      }
      topicId = topic.biliTopicId;
    }

    // 进入发布中（合法转移由状态机保证：TRANSLATED / PUBLISH_FAILED → PUBLISHING）
    this.workflow.transition(tweetId, WorkflowStatus.PUBLISHING, { lastError: null });

    try {
      // 只上传 photo（§21 / §53）；视频与视频封面永不进入 pics[]
      const photos = photoMedia(tweet);
      const pics: string[] = [];
      for (const photo of photos) {
        const { bytes, contentType } = await this.fetcher(photo.url);
        const filename = filenameForPhoto(photo.url, contentType);
        const imageUrl = await this.imageUploader.uploadImage(bytes, filename);
        pics.push(imageUrl);
        log('bilibili.upload.complete', `#${tweetId} ${imageUrl}`);
      }

      log('bilibili.publish.started', `#${tweetId} 文本 + ${pics.length} 张图片`);
      const dynamicId = await this.dynamicPublisher.publishDynamic({
        text: translation.text,
        pics,
        topicId,
      });
      const record = this.publishes.create({
        tweetId,
        translationId: translation.id,
        status: PublishStatus.SUCCESS,
        biliDynamicId: dynamicId,
        biliTopicId: topicId,
      });
      this.workflow.transition(tweetId, WorkflowStatus.PUBLISHED);
      log('bilibili.publish.complete', `#${tweetId} dynamic=${dynamicId}`);
      return { published: true, record };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.workflow.transition(tweetId, WorkflowStatus.PUBLISH_FAILED, { lastError: message });
      this.publishes.appendFailure(tweetId, message);
      log('bilibili.publish.failed', `#${tweetId}: ${message}`);
      throw error;
    }
  }

  isPublished(tweetId: number): boolean {
    return this.publishes.findSuccessfulByTweet(tweetId) !== null;
  }
}

/** 从 photo URL 推断上传文件名（含扩展名，Bilibili 按扩展名处理）。 */
export function filenameForPhoto(url: string, contentType: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = path.basename(pathname).replace(/[^\w.-]/g, '_');
    const ext = path.extname(base).toLowerCase();
    if (ext && /^\.(jpg|jpeg|png|webp|gif|avif)$/.test(ext)) {
      return base;
    }
  } catch {
    // 忽略 URL 解析失败，走 Content-Type 兜底
  }
  const ext = EXT_BY_CONTENT_TYPE[contentType] ?? 'jpg';
  return `twitter-${Date.now()}.${ext}`;
}

export class StubPublishService implements PublishService {
  publish(_tweetId: number, _topicAlias?: string): Promise<PublishResult> {
    throw new NotImplementedError('PublishService（Phase 8）');
  }

  isPublished(_tweetId: number): boolean {
    throw new NotImplementedError('PublishService（Phase 8）');
  }
}
