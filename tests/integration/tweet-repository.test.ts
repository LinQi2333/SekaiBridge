import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowStatus, SourceStatus } from '../../src/domain/workflow.js';
import { DuplicateTweetError, TweetRepository } from '../../src/repositories/tweet-repository.js';
import { AppDatabase } from '../../src/db/database.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;
let repo: TweetRepository | null = null;

afterEach(() => {
  repo = null;
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

function setup(): TweetRepository {
  testDb = createTestDb();
  repo = new TweetRepository(testDb.app.db);
  return repo;
}

describe('TweetRepository（规格 §8 / §10）', () => {
  it('创建推文并分配本地编号', () => {
    const r = setup();
    const tweet = r.create(tweetInput({ xTweetId: '100' }));
    expect(tweet.id).toBe(1);
    expect(tweet.xTweetId).toBe('100');
    expect(tweet.workflowStatus).toBe(WorkflowStatus.DETECTED);
    expect(tweet.sourceStatus).toBe(SourceStatus.ACTIVE);
    expect(tweet.retryCount).toBe(0);
    expect(tweet.originalText).toBe('今日も頑張る！🌸😭\n\n第二行');
    expect(r.findById(1)?.id).toBe(1);
    expect(r.findByXId('100')?.id).toBe(1);
  });

  it('x_tweet_id 唯一去重（规格 §19）', () => {
    const r = setup();
    r.create(tweetInput({ xTweetId: '100' }));
    expect(() => r.create(tweetInput({ xTweetId: '100' }))).toThrow(DuplicateTweetError);
  });

  it('findOrCreate 幂等：已存在返回原记录', () => {
    const r = setup();
    const first = r.create(tweetInput({ xTweetId: '100' }));
    const second = r.findOrCreate(tweetInput({ xTweetId: '100' }));
    expect(second.created).toBe(false);
    expect(second.tweet.id).toBe(first.id);
    expect(r.count()).toBe(1);
  });

  it('重启后本地编号不变（规格 §8 / ㉑）', () => {
    testDb = createTestDb();
    const firstRepo = new TweetRepository(testDb.app.db);
    firstRepo.create(tweetInput({ xTweetId: '100' }));
    firstRepo.create(tweetInput({ xTweetId: '200' }));
    const idBefore = firstRepo.findByXId('100')?.id;
    testDb.app.close();

    const reopened = new AppDatabase({ path: testDb.dbPath });
    const secondRepo = new TweetRepository(reopened.db);
    expect(secondRepo.findByXId('100')?.id).toBe(idBefore);
    expect(secondRepo.findByXId('200')?.id).toBe(2);
    reopened.close();
    testDb = null;
  });

  it('list 过滤与分页', () => {
    const r = setup();
    r.create(tweetInput({ xTweetId: '100' }));
    const translated = r.create(tweetInput({ xTweetId: '200' }));
    r.updateWorkflowStatus(translated.id, WorkflowStatus.TRANSLATED);
    const failed = r.create(tweetInput({ xTweetId: '300' }));
    r.updateWorkflowStatus(failed.id, WorkflowStatus.PUBLISH_FAILED);
    const published = r.create(tweetInput({ xTweetId: '400' }));
    r.updateWorkflowStatus(published.id, WorkflowStatus.PUBLISHED);

    expect(r.list({ filter: 'pending' })).toHaveLength(1);
    expect(r.list({ filter: 'translated' })).toHaveLength(1);
    expect(r.list({ filter: 'failed' })).toHaveLength(1);
    expect(r.list({ filter: 'published' })).toHaveLength(1);
    expect(r.list({ filter: 'all' })).toHaveLength(4);
    expect(r.count({ filter: 'all' })).toBe(4);

    // 分页：每页 2 条，第 2 页剩 2 条
    const page2 = r.list({ filter: 'all', page: 2, pageSize: 2 });
    expect(page2).toHaveLength(2);
  });

  it('更新工作流状态与错误信息', () => {
    const r = setup();
    const tweet = r.create(tweetInput());
    const updated = r.updateWorkflowStatus(tweet.id, WorkflowStatus.PUBLISH_FAILED, {
      lastError: 'Bilibili cookie 失效',
      retryCount: 2,
    });
    expect(updated?.workflowStatus).toBe(WorkflowStatus.PUBLISH_FAILED);
    expect(updated?.lastError).toBe('Bilibili cookie 失效');
    expect(updated?.retryCount).toBe(2);
  });

  it('来源状态与截图路径', () => {
    const r = setup();
    const tweet = r.create(tweetInput());
    expect(r.setSourceStatus(tweet.id, SourceStatus.SOURCE_DELETED)?.sourceStatus).toBe(
      SourceStatus.SOURCE_DELETED,
    );
    expect(r.setScreenshotPath(tweet.id, 'cache/screenshots/1.png')?.screenshotPath).toBe(
      'cache/screenshots/1.png',
    );
  });

  it('listForSourceCheck 只返回仍在处理中的推文（规格 §12）', () => {
    const r = setup();
    r.create(tweetInput({ xTweetId: '100' })); // DETECTED，不在检查范围
    const waiting = r.create(tweetInput({ xTweetId: '200' }));
    r.updateWorkflowStatus(waiting.id, WorkflowStatus.WAITING_TRANSLATION);
    const published = r.create(tweetInput({ xTweetId: '300' }));
    r.updateWorkflowStatus(published.id, WorkflowStatus.PUBLISHED);

    const due = r.listForSourceCheck();
    expect(due.map((t) => t.xTweetId)).toEqual(['200']);
  });

  it('listWithoutScreenshot 只返回没有截图的推文', () => {
    const r = setup();
    const noShot = r.create(tweetInput({ xTweetId: '100' }));
    const withShot = r.create(tweetInput({ xTweetId: '200' }));
    r.setScreenshotPath(withShot.id, 'cache/screenshots/2.png');

    const due = r.listWithoutScreenshot();
    expect(due.map((t) => t.id)).toEqual([noShot.id]);
  });
});
