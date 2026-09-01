import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/config.js';
import { createMediaFetcher } from '../media/media-fetcher.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { TranslationRepository } from '../repositories/translation-repository.js';
import { WatchRepository } from '../repositories/watch-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { PublishRepository } from '../repositories/publish-repository.js';
import { MessageDedupeRepository } from '../repositories/message-dedupe-repository.js';
import { NotificationRepository } from '../repositories/notification-repository.js';
import type { TweetToasterClient } from '../tweettoaster/client.js';
import { SqliteWatchService, type WatchService } from './watch-service.js';
import { SqliteTranslationService, type TranslationService } from './translation-service.js';
import { SqliteTopicService, type TopicService } from './topic-service.js';
import { SqliteTweetQueryService, type TweetQueryService } from './tweet-query-service.js';
import { SqliteWorkflowService, type WorkflowService } from './workflow-service.js';
import {
  SqliteMonitorService,
  StubMonitorService,
  type MonitorPollResult,
  type MonitorService,
} from './monitor-service.js';
import {
  DefaultSourceValidationService,
  StubSourceValidationService,
  type SourceValidationService,
} from './source-validation-service.js';
import {
  DefaultScreenshotService,
  StubScreenshotService,
  type ScreenshotService,
} from './screenshot-service.js';
import { DefaultMediaService, StubMediaService, type MediaService } from './media-service.js';
import {
  DefaultNewTweetProcessor,
  type NewTweetProcessor,
} from './tweet-processor.js';
import type { ImageUploader } from '../bilibili/image-upload.js';
import type { DynamicPublisher } from '../bilibili/dynamic-publisher.js';
import {
  DefaultPublishService,
  StubPublishService,
  type PublishService,
} from './publish-service.js';

/**
 * 应用服务容器（规格 §4 / §61）。
 * 未来 Web 端通过同一容器复用同一套 Services，不依赖 QQ。
 */
export interface AppServices {
  watch: WatchService;
  tweetQuery: TweetQueryService;
  translation: TranslationService;
  topic: TopicService;
  publish: PublishService;
  workflow: WorkflowService;
  monitor: MonitorService;
  sourceValidation: SourceValidationService;
  screenshot: ScreenshotService;
  media: MediaService;
  newTweetProcessor: NewTweetProcessor;
  /** 按 B站话题号反查话题名（添加话题时未给名称用；无客户端时 undefined）。 */
  resolveTopicName?: (topicId: string) => Promise<string | null>;
}

export interface Repositories {
  tweets: TweetRepository;
  translations: TranslationRepository;
  watch: WatchRepository;
  topics: TopicRepository;
  publish: PublishRepository;
  messageDedupe: MessageDedupeRepository;
  notifications: NotificationRepository;
}

export function createRepositories(db: Database.Database): Repositories {
  return {
    tweets: new TweetRepository(db),
    translations: new TranslationRepository(db),
    watch: new WatchRepository(db),
    topics: new TopicRepository(db),
    publish: new PublishRepository(db),
    messageDedupe: new MessageDedupeRepository(db),
    notifications: new NotificationRepository(db),
  };
}

/** 创建真实外部依赖所需的环境（不传则使用 stub）。 */
export interface ServiceDeps {
  config: AppConfig;
  tweetToaster: TweetToasterClient;
  /** 增量新推文回调（NoneBot2 通知由默认处理器生成）；不传则默认走 newTweetProcessor。 */
  onNewTweets?: (tweets: import('../domain/tweet.js').Tweet[]) => void | Promise<void>;
  /** 发布服务注入（测试用）；不传则使用 stub。 */
  publish?: PublishService;
  /** Bilibili 上传/发布器（提供后自动构造真实 PublishService）。 */
  bilibili?: {
    imageUploader: ImageUploader;
    dynamicPublisher: DynamicPublisher;
  };
  /** Bilibili 客户端（提供后用于话题名反查等尽力而为的能力）。 */
  biliClient?: import('../bilibili/client.js').BilibiliClient;
  /** 全局 fetch 注入（测试用；默认 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
}

export function createServices(repos: Repositories, deps?: ServiceDeps): AppServices {
  const workflow = new SqliteWorkflowService(repos.tweets);
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  // 媒体获取策略：Twitter 图片走 TweetToaster /api/media 代理，其余直连（§48 安全约束）
  const mediaFetcher = createMediaFetcher(deps?.tweetToaster, { fetchImpl });
  const screenshot: ScreenshotService = deps
    ? new DefaultScreenshotService({
        tweets: repos.tweets,
        tweetToaster: deps.tweetToaster,
        cacheDir: path.join(deps.config.cacheRoot, 'screenshots'),
        cacheRoot: deps.config.cacheRoot,
        fetchImpl,
      })
    : new StubScreenshotService();
  const media: MediaService = deps
    ? new DefaultMediaService({
        tweets: repos.tweets,
        cacheRoot: deps.config.cacheRoot,
        fetchImpl,
        fetcher: mediaFetcher,
      })
    : new StubMediaService();
  const newTweetProcessor = new DefaultNewTweetProcessor({
    tweets: repos.tweets,
    workflow,
    screenshot,
    media,
    notifications: repos.notifications,
  });
  const sourceValidation: SourceValidationService = deps
    ? new DefaultSourceValidationService({
        tweets: repos.tweets,
        tweetToaster: deps.tweetToaster,
        checkIntervalMs: deps.config.sourceCheckInterval * 1000,
      })
    : new StubSourceValidationService();

  const monitor: MonitorService = deps
    ? new SqliteMonitorService({
        watch: repos.watch,
        tweets: repos.tweets,
        tweetToaster: deps.tweetToaster,
        pollIntervalMs: deps.config.twitterPollInterval * 1000,
        onNewTweets: deps.onNewTweets ?? ((tweets) => newTweetProcessor.process(tweets)),
      })
    : new StubMonitorService();

  const publish: PublishService =
    deps?.publish ??
    (deps?.bilibili
      ? new DefaultPublishService({
          tweets: repos.tweets,
          translations: repos.translations,
          topics: repos.topics,
          publishes: repos.publish,
          workflow,
          imageUploader: deps.bilibili.imageUploader,
          dynamicPublisher: deps.bilibili.dynamicPublisher,
          fetchImpl,
          fetcher: mediaFetcher,
        })
      : new StubPublishService());

  return {
    watch: new SqliteWatchService(repos.watch, repos.tweets),
    tweetQuery: new SqliteTweetQueryService(repos.tweets),
    translation: new SqliteTranslationService(repos.tweets, repos.translations, workflow),
    topic: new SqliteTopicService(repos.topics),
    publish,
    workflow,
    monitor,
    sourceValidation,
    screenshot,
    media,
    newTweetProcessor,
    resolveTopicName: deps?.biliClient
      ? (topicId: string) => deps.biliClient!.fetchTopicName(topicId)
      : undefined,
  };
}

export { SqliteMonitorService } from './monitor-service.js';
export { DefaultNewTweetProcessor } from './tweet-processor.js';
export type {
  WatchService,
  TranslationService,
  TopicService,
  TweetQueryService,
  WorkflowService,
  MonitorService,
  MonitorPollResult,
  NewTweetProcessor,
  SourceValidationService,
  ScreenshotService,
  MediaService,
  PublishService,
};
