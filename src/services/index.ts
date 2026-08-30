import type Database from 'better-sqlite3';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { TranslationRepository } from '../repositories/translation-repository.js';
import { WatchRepository } from '../repositories/watch-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { PublishRepository } from '../repositories/publish-repository.js';
import { MessageDedupeRepository } from '../repositories/message-dedupe-repository.js';
import { SqliteWatchService, type WatchService } from './watch-service.js';
import { SqliteTranslationService, type TranslationService } from './translation-service.js';
import { SqliteTopicService, type TopicService } from './topic-service.js';
import { SqliteTweetQueryService, type TweetQueryService } from './tweet-query-service.js';
import { SqliteWorkflowService, type WorkflowService } from './workflow-service.js';
import {
  StubMonitorService,
  type MonitorService,
} from './monitor-service.js';
import {
  StubSourceValidationService,
  type SourceValidationService,
} from './source-validation-service.js';
import { StubScreenshotService, type ScreenshotService } from './screenshot-service.js';
import { StubMediaService, type MediaService } from './media-service.js';
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

export function createServices(repos: Repositories): AppServices {
  const workflow = new SqliteWorkflowService(repos.tweets);
  return {
    watch: new SqliteWatchService(repos.watch),
    tweetQuery: new SqliteTweetQueryService(repos.tweets),
    translation: new SqliteTranslationService(repos.tweets, repos.translations, workflow),
    topic: new SqliteTopicService(repos.topics, repos.tweets),
    publish: new StubPublishService(),
    workflow,
    monitor: new StubMonitorService(),
    sourceValidation: new StubSourceValidationService(),
    screenshot: new StubScreenshotService(),
    media: new StubMediaService(),
  };
}

export type {
  WatchService,
  TranslationService,
  TopicService,
  TweetQueryService,
  WorkflowService,
  MonitorService,
  SourceValidationService,
  ScreenshotService,
  MediaService,
  PublishService,
};
