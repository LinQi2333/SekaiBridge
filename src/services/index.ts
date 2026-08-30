import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/config.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { TranslationRepository } from '../repositories/translation-repository.js';
import { WatchRepository } from '../repositories/watch-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { PublishRepository } from '../repositories/publish-repository.js';
import { MessageDedupeRepository } from '../repositories/message-dedupe-repository.js';
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
import { StubPublishService, type PublishService } from './publish-service.js';

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
}

export interface Repositories {
  tweets: TweetRepository;
  translations: TranslationRepository;
  watch: WatchRepository;
  topics: TopicRepository;
  publish: PublishRepository;
  messageDedupe: MessageDedupeRepository;
}

export function createRepositories(db: Database.Database): Repositories {
  return {
    tweets: new TweetRepository(db),
    translations: new TranslationRepository(db),
    watch: new WatchRepository(db),
    topics: new TopicRepository(db),
    publish: new PublishRepository(db),
    messageDedupe: new MessageDedupeRepository(db),
  };
}

/** 创建真实外部依赖所需的环境（不传则使用 stub）。 */
export interface ServiceDeps {
  config: AppConfig;
  tweetToaster: TweetToasterClient;
  /** 增量新推文回调（Phase 6 在此发送 QQ 通知）；不传则默认走 newTweetProcessor。 */
  onNewTweets?: (tweets: import('../domain/tweet.js').Tweet[]) => void;
}

export function createServices(repos: Repositories, deps?: ServiceDeps): AppServices {
  const workflow = new SqliteWorkflowService(repos.tweets);
  const screenshot: ScreenshotService = deps
    ? new DefaultScreenshotService({
        tweets: repos.tweets,
        tweetToaster: deps.tweetToaster,
        cacheDir: path.join(deps.config.cacheRoot, 'screenshots'),
      })
    : new StubScreenshotService();
  const media: MediaService = deps
    ? new DefaultMediaService({ tweets: repos.tweets, cacheRoot: deps.config.cacheRoot })
    : new StubMediaService();
  const newTweetProcessor = new DefaultNewTweetProcessor({
    tweets: repos.tweets,
    workflow,
    screenshot,
    media,
  });

  const monitor: MonitorService = deps
    ? new SqliteMonitorService({
        watch: repos.watch,
        tweets: repos.tweets,
        tweetToaster: deps.tweetToaster,
        pollIntervalMs: deps.config.twitterPollInterval * 1000,
        onNewTweets: deps.onNewTweets ?? ((tweets) => void newTweetProcessor.process(tweets)),
      })
    : new StubMonitorService();

  return {
    watch: new SqliteWatchService(repos.watch),
    tweetQuery: new SqliteTweetQueryService(repos.tweets),
    translation: new SqliteTranslationService(repos.tweets, repos.translations, workflow),
    topic: new SqliteTopicService(repos.topics, repos.tweets),
    publish: new StubPublishService(),
    workflow,
    monitor,
    sourceValidation: new StubSourceValidationService(),
    screenshot,
    media,
    newTweetProcessor,
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
