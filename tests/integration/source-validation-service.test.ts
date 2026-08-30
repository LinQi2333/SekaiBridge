import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceStatus, WorkflowStatus } from '../../src/domain/workflow.js';
import { TweetRepository } from '../../src/repositories/tweet-repository.js';
import { DefaultSourceValidationService } from '../../src/services/source-validation-service.js';
import { SqliteWorkflowService } from '../../src/services/workflow-service.js';
import { NotFoundError } from '../../src/services/errors.js';
import { TweetNotFoundError, TweetToasterUnavailableError } from '../../src/tweettoaster/errors.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;

afterEach(() => {
  vi.useRealTimers();
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

function setup(responder: (url: string) => Promise<unknown>) {
  testDb = createTestDb();
  const tweets = new TweetRepository(testDb.app.db);
  const getTweet = vi.fn(async (url: string) => responder(url));
  const service = new DefaultSourceValidationService({
    tweets,
    tweetToaster: { getTweet },
    checkIntervalMs: 60_000,
  });
  return { tweets, service, getTweet };
}

describe('SourceValidationService（规格 §12 / §13 / §50）', () => {
  it('Case A：单推明确 404 → source_status = SOURCE_DELETED', async () => {
    const { tweets, service } = setup(async () => {
      throw new TweetNotFoundError('推文不存在、已删除或暂时无法读取');
    });
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));
    tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.WAITING_TRANSLATION);

    const deleted = await service.checkDue();
    expect(deleted).toEqual([tweet.id]);
    expect(tweets.findById(tweet.id)?.sourceStatus).toBe(SourceStatus.SOURCE_DELETED);
  });

  it('Case B：单推仍存在（即使不在 timeline）→ 保持 ACTIVE', async () => {
    const { tweets, service } = setup(async () => ({ id: '100' }));
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));
    tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.TRANSLATED);

    const deleted = await service.checkDue();
    expect(deleted).toEqual([]);
    expect(tweets.findById(tweet.id)?.sourceStatus).toBe(SourceStatus.ACTIVE);
  });

  it('Case C：已翻译后删除 → TRANSLATED 与 SOURCE_DELETED 同时成立', async () => {
    const { tweets, service } = setup(async () => {
      throw new TweetNotFoundError('deleted');
    });
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));
    tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.TRANSLATED);

    await service.checkDue();
    const updated = tweets.findById(tweet.id);
    expect(updated?.workflowStatus).toBe(WorkflowStatus.TRANSLATED);
    expect(updated?.sourceStatus).toBe(SourceStatus.SOURCE_DELETED);
  });

  it('Case D：已发布后删除 → PUBLISHED 与 SOURCE_DELETED 并存，不自动删除任何记录', async () => {
    const { tweets, service } = setup(async () => {
      throw new TweetNotFoundError('deleted');
    });
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));
    // 走合法路径进入 PUBLISHED
    const workflow = new SqliteWorkflowService(tweets);
    workflow.transition(tweet.id, WorkflowStatus.TRANSLATED);
    workflow.transition(tweet.id, WorkflowStatus.PUBLISHING);
    workflow.transition(tweet.id, WorkflowStatus.PUBLISHED);

    // PUBLISHED 不在默认检查范围（规格 §12 低频/不主动检查）
    expect(await service.checkDue()).toEqual([]);
    // /查看 时允许手动刷新检查
    expect(await service.checkTweet(tweet.id)).toBe(true);

    const updated = tweets.findById(tweet.id);
    expect(updated?.workflowStatus).toBe(WorkflowStatus.PUBLISHED);
    expect(updated?.sourceStatus).toBe(SourceStatus.SOURCE_DELETED);
    // 本地数据不丢
    expect(updated?.originalText).toBe('今日も頑張る！🌸😭\n\n第二行');
    expect(tweets.count({ filter: 'all' })).toBe(1);
  });

  it('checkDue 只检查处理中的状态（规格 §12 优先级）', async () => {
    const { tweets, service, getTweet } = setup(async () => ({ id: 'x' }));
    const waiting = tweets.create(tweetInput({ xTweetId: '100' }));
    tweets.updateWorkflowStatus(waiting.id, WorkflowStatus.WAITING_TRANSLATION);
    const fresh = tweets.create(tweetInput({ xTweetId: '200' })); // DETECTED，不检查
    const published = tweets.create(tweetInput({ xTweetId: '300' }));
    tweets.updateWorkflowStatus(published.id, WorkflowStatus.PUBLISHED);

    await service.checkDue();
    const calledUrls = getTweet.mock.calls.map((c) => String(c[0]));
    expect(calledUrls).toHaveLength(1);
    expect(calledUrls[0]).toBe(tweets.findById(waiting.id)?.tweetUrl);
    expect(fresh.workflowStatus).toBe(WorkflowStatus.DETECTED);
  });

  it('网络错误（Provider 不可用）不标记删除（规格 §12：必须明确确认）', async () => {
    const { tweets, service } = setup(async () => {
      throw new TweetToasterUnavailableError('TweetToaster 不可用');
    });
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));
    tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.TRANSLATED);

    const deleted = await service.checkDue();
    expect(deleted).toEqual([]);
    expect(tweets.findById(tweet.id)?.sourceStatus).toBe(SourceStatus.ACTIVE);
  });

  it('checkTweet：不存在的推文抛 NotFoundError；已删除状态幂等返回 true', async () => {
    const { tweets, service } = setup(async () => {
      throw new TweetNotFoundError('deleted');
    });
    await expect(service.checkTweet(9999)).rejects.toBeInstanceOf(NotFoundError);

    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));
    expect(await service.checkTweet(tweet.id)).toBe(true);
    expect(await service.checkTweet(tweet.id)).toBe(true); // 幂等，不再请求
  });

  it('onDeleted 回调在新标记删除时触发', async () => {
    testDb = createTestDb();
    const tweets = new TweetRepository(testDb.app.db);
    const onDeleted = vi.fn();
    const service = new DefaultSourceValidationService({
      tweets,
      tweetToaster: {
        getTweet: async () => {
          throw new TweetNotFoundError('deleted');
        },
      },
      checkIntervalMs: 60_000,
      onDeleted,
    });
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));
    tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.WAITING_TRANSLATION);
    await service.checkDue();
    expect(onDeleted).toHaveBeenCalledWith([tweet.id]);
  });

  it('调度器：start 后按 SOURCE_CHECK_INTERVAL 周期检查，stop 停止', async () => {
    vi.useFakeTimers();
    testDb = createTestDb();
    const tweets = new TweetRepository(testDb.app.db);
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));
    tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.TRANSLATED);
    const getTweet = vi.fn(async () => ({ id: '100' }));
    const service = new DefaultSourceValidationService({
      tweets,
      tweetToaster: { getTweet },
      checkIntervalMs: 1000,
    });

    service.start();
    expect(service.isRunning()).toBe(true);
    expect(getTweet).not.toHaveBeenCalled(); // 首次周期后才检查

    await vi.advanceTimersByTimeAsync(1000);
    expect(getTweet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getTweet).toHaveBeenCalledTimes(2);

    service.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getTweet).toHaveBeenCalledTimes(2);
  });
});
