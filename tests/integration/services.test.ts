import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowStatus } from '../../src/domain/workflow.js';
import { createRepositories, createServices, type AppServices } from '../../src/services/index.js';
import {
  AlreadyExistsError,
  IllegalTransitionError,
  NotFoundError,
  ValidationError,
} from '../../src/services/errors.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;
let services: AppServices | null = null;

afterEach(() => {
  services = null;
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

function setup(): AppServices {
  testDb = createTestDb();
  services = createServices(createRepositories(testDb.app.db));
  return services;
}

function createTweet(s: AppServices, xId = '100'): number {
  return s.tweetQuery.getByXId(xId)?.id ?? 0;
}

describe('WatchService（规格 §5 / §25）', () => {
  it('添加时规范化账号名（去 @、小写）', () => {
    const s = setup();
    const account = s.watch.add(' @FooBar ');
    expect(account.screenName).toBe('foobar');
    expect(account.enabled).toBe(true);
    expect(account.bootstrapCompleted).toBe(false);
  });

  it('重复添加抛 AlreadyExistsError', () => {
    const s = setup();
    s.watch.add('foo');
    expect(() => s.watch.add('@FOO')).toThrow(AlreadyExistsError);
  });

  it('非法账号名抛 ValidationError', () => {
    const s = setup();
    expect(() => s.watch.add('foo bar!')).toThrow(ValidationError);
    expect(() => s.watch.add('')).toThrow(ValidationError);
  });

  it('开启 / 关闭 / 列表 / 删除', () => {
    const s = setup();
    s.watch.add('foo');
    s.watch.add('bar');
    expect(s.watch.list()).toHaveLength(2);

    s.watch.disable('foo');
    expect(s.watch.list().find((a) => a.screenName === 'foo')?.enabled).toBe(false);
    s.watch.enable('foo');
    expect(s.watch.list().find((a) => a.screenName === 'foo')?.enabled).toBe(true);

    expect(s.watch.remove('bar')).toBe(true);
    expect(s.watch.list()).toHaveLength(1);
    expect(s.watch.remove('bar')).toBe(false);
  });

  it('对不存在的账号开启/关闭抛 NotFoundError', () => {
    const s = setup();
    expect(() => s.watch.enable('ghost')).toThrow(NotFoundError);
  });

  it('0 个监听账户时应用状态正常（规格 §5 / §54-1）', () => {
    const s = setup();
    expect(s.watch.list()).toEqual([]);
  });
});

describe('WorkflowService（规格 §11）', () => {
  it('合法转移生效，非法转移抛 IllegalTransitionError', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));

    s.workflow.transition(tweet.id, WorkflowStatus.SCREENSHOT_READY);
    expect(s.workflow.getStatus(tweet.id).workflowStatus).toBe(WorkflowStatus.SCREENSHOT_READY);

    expect(() => s.workflow.transition(tweet.id, WorkflowStatus.PUBLISHED)).toThrow(
      IllegalTransitionError,
    );
    expect(() => s.workflow.transition(9999, WorkflowStatus.TRANSLATED)).toThrow(NotFoundError);
  });

  it('转移到相同状态是幂等成功', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));
    s.workflow.transition(tweet.id, WorkflowStatus.TRANSLATED);
    s.workflow.transition(tweet.id, WorkflowStatus.TRANSLATED); // 不抛错
    expect(s.workflow.getStatus(tweet.id).workflowStatus).toBe(WorkflowStatus.TRANSLATED);
  });
});

describe('TranslationService（规格 §28 / §29 / §30）', () => {
  it('提交翻译保留 emoji / 换行 / 空行，版本递增，状态变为 TRANSLATED', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));

    const first = s.translation.submit(tweet.id, '10001', '第一版 🌸\n\n(｡･ω･｡)');
    expect(first.translation.version).toBe(1);
    expect(first.translation.text).toBe('第一版 🌸\n\n(｡･ω･｡)');
    expect(first.workflowStatus).toBe(WorkflowStatus.TRANSLATED);

    const second = s.translation.submit(tweet.id, '10001', '第二版 ✨');
    expect(second.translation.version).toBe(2);

    expect(s.translation.getLatest(tweet.id)?.version).toBe(2);
    expect(s.translation.listVersions(tweet.id)).toHaveLength(2);
  });

  it('\\r\\n 规范化为 \\n，其余内容不变', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));
    const result = s.translation.submit(tweet.id, '10001', '第一行\r\n\r\n第二行 🌸');
    expect(result.translation.text).toBe('第一行\n\n第二行 🌸');
  });

  it('空翻译抛 ValidationError，不存在的推文抛 NotFoundError', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));

    expect(() => s.translation.submit(tweet.id, '10001', '   ')).toThrow(ValidationError);
    expect(() => s.translation.submit(9999, '10001', '内容')).toThrow(NotFoundError);
    expect(() => s.translation.getLatest(9999)).toThrow(NotFoundError);
  });

  it('发布失败后可以重新提交翻译修订（PUBLISH_FAILED → TRANSLATED）', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));
    // 走合法路径进入 PUBLISH_FAILED：DETECTED → TRANSLATED → PUBLISHING → PUBLISH_FAILED
    s.workflow.transition(tweet.id, WorkflowStatus.TRANSLATED);
    s.workflow.transition(tweet.id, WorkflowStatus.PUBLISHING);
    s.workflow.transition(tweet.id, WorkflowStatus.PUBLISH_FAILED, { lastError: 'cookie 失效' });
    const result = s.translation.submit(tweet.id, '10001', '修订版');
    expect(result.workflowStatus).toBe(WorkflowStatus.TRANSLATED);
  });
});

describe('TopicService（规格 §31 / §32）', () => {
  it('创建话题、查看列表、给推文设置 / 取消话题', () => {
    const s = setup();
    const topic = s.topic.createTopic({ alias: 'hololive', biliTopicId: '23456', name: 'hololive' });
    expect(topic.enabled).toBe(true);
    expect(s.topic.list().map((t) => t.alias)).toEqual(['hololive']);

    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));

    s.topic.setTopic(tweet.id, 'hololive');
    expect(s.tweetQuery.getById(tweet.id).topicAlias).toBe('hololive');

    s.topic.setTopic(tweet.id, null); // 取消
    expect(s.tweetQuery.getById(tweet.id).topicAlias).toBeNull();
  });

  it('重复别名抛 AlreadyExistsError；未知话题抛 NotFoundError', () => {
    const s = setup();
    s.topic.createTopic({ alias: 'hololive', biliTopicId: '23456', name: 'hololive' });
    expect(() => s.topic.createTopic({ alias: 'hololive', biliTopicId: '1', name: 'x' })).toThrow(
      AlreadyExistsError,
    );

    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));
    expect(() => s.topic.setTopic(tweet.id, 'ghost')).toThrow(NotFoundError);
    expect(() => s.topic.setTopic(9999, 'hololive')).toThrow(NotFoundError);
  });
});

describe('TweetQueryService（规格 §26 / §27）', () => {
  it('getById / getByXId / 不存在抛 NotFoundError', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));
    expect(s.tweetQuery.getById(tweet.id).xTweetId).toBe('100');
    expect(s.tweetQuery.getByXId('100')?.id).toBe(tweet.id);
    expect(() => s.tweetQuery.getById(9999)).toThrow(NotFoundError);
  });

  it('list 过滤与分页', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const t1 = repo.tweets.create(tweetInput({ xTweetId: '100' }));
    repo.tweets.updateWorkflowStatus(t1.id, WorkflowStatus.TRANSLATED);
    repo.tweets.create(tweetInput({ xTweetId: '200' }));

    const translated = s.tweetQuery.list('translated');
    expect(translated.total).toBe(1);
    expect(translated.items[0]?.id).toBe(t1.id);

    const pending = s.tweetQuery.list('pending');
    expect(pending.total).toBe(1);

    const all = s.tweetQuery.list('all', { pageSize: 1, page: 2 });
    expect(all.items).toHaveLength(1);
    expect(all.page).toBe(2);
  });
});

describe('Services 与 QQ 解耦（规格 §10 / §61 / §54-22）', () => {
  it('未来 Web 可直接调用同一套 Services，无需 QQ 命令解析器', () => {
    const s = setup();
    const repo = createRepositories(testDb!.app.db);
    const tweet = repo.tweets.create(tweetInput({ xTweetId: '100' }));

    // 与 /翻译 /话题 /查看 /发布 对应的纯服务调用
    const result = s.translation.submit(tweet.id, '10001', '译文 🌸');
    expect(result.translation.version).toBe(1);
    s.topic.createTopic({ alias: 'hololive', biliTopicId: '23456', name: 'hololive' });
    s.topic.setTopic(tweet.id, 'hololive');
    expect(s.tweetQuery.getById(tweet.id).topicAlias).toBe('hololive');
    expect(createTweet(s)).toBeGreaterThan(0);
  });
});
