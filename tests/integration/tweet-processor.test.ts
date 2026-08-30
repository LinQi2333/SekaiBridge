import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowStatus } from '../../src/domain/workflow.js';
import { TweetRepository } from '../../src/repositories/tweet-repository.js';
import { DefaultNewTweetProcessor } from '../../src/services/tweet-processor.js';
import { SqliteWorkflowService } from '../../src/services/workflow-service.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;

afterEach(() => {
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

function setup() {
  testDb = createTestDb();
  const tweets = new TweetRepository(testDb.app.db);
  const workflow = new SqliteWorkflowService(tweets);
  const screenshot = {
    render: vi.fn(async () => `cache/screenshots/1.png`),
  };
  const media = {
    cachePhotos: vi.fn(async () => ['cache/twitter-photos/1/0.jpg']),
    cacheVideoThumbnails: vi.fn(async () => []),
  };
  const processor = new DefaultNewTweetProcessor({ tweets, workflow, screenshot, media });
  return { tweets, workflow, screenshot, media, processor };
}

describe('DefaultNewTweetProcessor（规格 §1 流程）', () => {
  it('新推文：截图 → SCREENSHOT_READY → 媒体缓存', async () => {
    const { tweets, screenshot, media, processor } = setup();
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));

    await processor.process([tweet]);

    expect(screenshot.render).toHaveBeenCalledWith(tweet.id);
    expect(media.cachePhotos).toHaveBeenCalledWith(tweet.id);
    expect(media.cacheVideoThumbnails).toHaveBeenCalledWith(tweet.id);
    const updated = tweets.findById(tweet.id);
    expect(updated?.workflowStatus).toBe(WorkflowStatus.SCREENSHOT_READY);
    expect(updated?.screenshotPath).toBe('cache/screenshots/1.png');
    expect(updated?.lastError).toBeNull();
  });

  it('截图失败：保持 DETECTED + 记录 lastError，跳过媒体处理', async () => {
    const { tweets, screenshot, media, processor } = setup();
    screenshot.render.mockRejectedValue(new Error('TweetToaster 不可用'));
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));

    await processor.process([tweet]);

    const updated = tweets.findById(tweet.id);
    expect(updated?.workflowStatus).toBe(WorkflowStatus.DETECTED);
    expect(updated?.lastError).toContain('TweetToaster 不可用');
    expect(updated?.screenshotPath).toBeNull();
    expect(media.cachePhotos).not.toHaveBeenCalled();
    expect(media.cacheVideoThumbnails).not.toHaveBeenCalled();
  });

  it('媒体缓存失败：不回退截图状态，只记录日志', async () => {
    const { tweets, media, processor } = setup();
    media.cachePhotos.mockRejectedValue(new Error('下载超时'));
    const tweet = tweets.create(tweetInput({ xTweetId: '100' }));

    await processor.process([tweet]);

    const updated = tweets.findById(tweet.id);
    expect(updated?.workflowStatus).toBe(WorkflowStatus.SCREENSHOT_READY);
    expect(updated?.screenshotPath).toBe('cache/screenshots/1.png');
  });

  it('多条推文：一条失败不影响其他', async () => {
    const { tweets, screenshot, processor } = setup();
    const bad = tweets.create(tweetInput({ xTweetId: '100' }));
    const good = tweets.create(tweetInput({ xTweetId: '200' }));
    screenshot.render.mockImplementation(async (id: number) => {
      if (id === bad.id) throw new Error('渲染失败');
      return `cache/screenshots/${id}.png`;
    });

    await processor.process([bad, good]);

    expect(tweets.findById(bad.id)?.workflowStatus).toBe(WorkflowStatus.DETECTED);
    expect(tweets.findById(good.id)?.workflowStatus).toBe(WorkflowStatus.SCREENSHOT_READY);
  });
});
