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
    expect(tweet.seq).toBe(1);
    expect(tweet.xTweetId).toBe('100');
    expect(tweet.workflowStatus).toBe(WorkflowStatus.DETECTED);
    expect(tweet.sourceStatus).toBe(SourceStatus.ACTIVE);
    expect(tweet.retryCount).toBe(0);
    expect(tweet.originalText).toBe('今日も頑張る！🌸😭\n\n第二行');
    expect(r.findById(1)?.id).toBe(1);
    expect(r.findByXId('100')?.id).toBe(1);
  });

  it('各账号独立编号（seq）：同账号递增，不同账号各自从 1 开始', () => {
    const r = setup();
    const a1 = r.create(tweetInput({ xTweetId: '100', authorScreenName: 'foo' }));
    const a2 = r.create(tweetInput({ xTweetId: '200', authorScreenName: 'foo' }));
    const b1 = r.create(tweetInput({ xTweetId: '300', authorScreenName: 'bar' }));
    const a3 = r.create(tweetInput({ xTweetId: '400', authorScreenName: 'foo' }));
    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(b1.seq).toBe(1);
    expect(a3.seq).toBe(3);

    // findByAccountAndSeq 按账号内编号查找
    expect(r.findByAccountAndSeq('foo', 2)?.xTweetId).toBe('200');
    expect(r.findByAccountAndSeq('bar', 1)?.xTweetId).toBe('300');
    expect(r.findByAccountAndSeq('foo', 1)?.xTweetId).toBe('100');
    expect(r.findByAccountAndSeq('foo', 5)).toBeNull();
    expect(r.findByAccountAndSeq('ghost', 1)).toBeNull();
  });

  it('deleteByAccount 只删该账号推文，返回删除数', () => {
    const r = setup();
    r.create(tweetInput({ xTweetId: '100', authorScreenName: 'foo' }));
    r.create(tweetInput({ xTweetId: '200', authorScreenName: 'foo' }));
    r.create(tweetInput({ xTweetId: '300', authorScreenName: 'bar' }));
    expect(r.deleteByAccount('foo')).toBe(2);
    expect(r.count({ filter: 'all' })).toBe(1);
    expect(r.findByXId('300')).not.toBeNull();
    expect(r.deleteByAccount('foo')).toBe(0);
  });

  it('作者名统一小写存储：混合大小写也能按小写账号查询', () => {
    const r = setup();
    const t = r.create(tweetInput({ xTweetId: '100', authorScreenName: 'Rin23331' }));
    expect(t.authorScreenName).toBe('rin23331');
    expect(r.findByAccountAndSeq('rin23331', 1)?.xTweetId).toBe('100');
    expect(r.findByAccountAndSeq('Rin23331', 1)?.xTweetId).toBe('100'); // 查询侧也转小写
    // 同账号大小写混合不会产生两条 seq=1
    r.create(tweetInput({ xTweetId: '200', authorScreenName: 'RIN23331' }));
    expect(r.findByAccountAndSeq('rin23331', 2)?.xTweetId).toBe('200');
    expect(r.findByAccountAndSeq('rin23331', 1)?.xTweetId).toBe('100');
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
