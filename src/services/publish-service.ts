import fs from 'node:fs/promises';
import type { DynamicPublisher } from '../bilibili/dynamic-publisher.js';
import type { ImageUploader, UploadedImage } from '../bilibili/image-upload.js';
import type { BiliTopic } from '../domain/topic.js';
import { PublishStatus, type PublishRecord } from '../domain/publish.js';
import { WorkflowStatus } from '../domain/workflow.js';
import { PublishRepository } from '../repositories/publish-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { TranslationRepository } from '../repositories/translation-repository.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { log } from '../logger.js';
import { NotFoundError, NotImplementedError, ValidationError } from './errors.js';
import type { MediaLibrary } from './media-library.js';
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
  /**
   * 媒体库：发布时直接读取 cache/media/<推文ID>/ 下的原图；
   * 没有缓存时由媒体库按需下载（不传则用 stub，测试需注入）。
   */
  media: MediaLibrary;
}

export class DefaultPublishService implements PublishService {
  private readonly tweets: TweetRepository;
  private readonly translations: TranslationRepository;
  private readonly topics: TopicRepository;
  private readonly publishes: PublishRepository;
  private readonly workflow: WorkflowService;
  private readonly imageUploader: ImageUploader;
  private readonly dynamicPublisher: DynamicPublisher;
  private readonly media: MediaLibrary;

  constructor(options: DefaultPublishServiceOptions) {
    this.tweets = options.tweets;
    this.translations = options.translations;
    this.topics = options.topics;
    this.publishes = options.publishes;
    this.workflow = options.workflow;
    this.imageUploader = options.imageUploader;
    this.dynamicPublisher = options.dynamicPublisher;
    this.media = options.media;
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

    // 话题：仅发布参数指定（已保存话题模型已移除，§33 新逻辑）
    const alias = topicAlias;
    let topic: BiliTopic | null = null;
    if (alias) {
      topic = this.topics.findByAlias(alias);
      if (!topic) {
        throw new ValidationError(`话题不存在: ${alias}`);
      }
      if (!topic.enabled) {
        throw new ValidationError(`话题已停用: ${alias}`);
      }
    }

    // 进入发布中（合法转移由状态机保证：TRANSLATED / PUBLISH_FAILED → PUBLISHING）
    this.workflow.transition(tweetId, WorkflowStatus.PUBLISHING, { lastError: null });

    try {
      // 只上传 photo（§21 / §53）；视频与视频封面永不进入 pics[]
      // 直接读取 cache/media/<推文ID>/ 下的原图（缺失时才由媒体库补下载）
      const photos = await this.media.ensurePhotos(tweetId);
      const pics: UploadedImage[] = [];
      for (const photo of photos) {
        const bytes = await fs.readFile(photo.absPath);
        const uploaded = await this.imageUploader.uploadImage(bytes, photo.name);
        pics.push(uploaded);
        log('bilibili.upload.complete', `#${tweetId} ${photo.name} → ${uploaded.url}`);
      }

      log('bilibili.publish.started', `#${tweetId} 文本 + ${pics.length} 张图片`);
      const dynamicId = await this.dynamicPublisher.publishDynamic({
        text: translation.text,
        pics,
        topicId: topic?.biliTopicId ?? null,
        // 不传别名作话题名：B 站校验 name 与 topic_id 匹配，别名会导致 4126130
        topicName: null,
      });
      const record = this.publishes.create({
        tweetId,
        translationId: translation.id,
        status: PublishStatus.SUCCESS,
        biliDynamicId: dynamicId,
        biliTopicId: topic?.biliTopicId ?? null,
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

export class StubPublishService implements PublishService {
  publish(_tweetId: number, _topicAlias?: string): Promise<PublishResult> {
    throw new NotImplementedError('PublishService 未接线');
  }

  isPublished(_tweetId: number): boolean {
    throw new NotImplementedError('PublishService 未接线');
  }
}
