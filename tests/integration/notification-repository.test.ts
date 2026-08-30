import { afterEach, describe, expect, it } from 'vitest';
import { NotificationRepository } from '../../src/repositories/notification-repository.js';
import { TweetRepository } from '../../src/repositories/tweet-repository.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;

afterEach(() => {
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

describe('NotificationRepository（规格 §42 通知队列）', () => {
  it('创建 / 拉取 pending / 标记已发送', () => {
    testDb = createTestDb();
    const tweets = new TweetRepository(testDb.app.db);
    const repo = new NotificationRepository(testDb.app.db);
    const tweet = tweets.create(tweetInput());

    const n1 = repo.create({
      tweetId: tweet.id,
      text: '【新推文 #1】\n账号：@example',
      screenshotPath: 'cache/screenshots/1.png',
      videoThumbnails: ['cache/video-thumbnails/1/0.jpg'],
    });
    const n2 = repo.create({
      tweetId: tweet.id,
      text: '第二条通知',
      screenshotPath: null,
      videoThumbnails: [],
    });

    expect(n1.status).toBe('PENDING');
    expect(n1.videoThumbnails).toEqual(['cache/video-thumbnails/1/0.jpg']);
    expect(n2.videoThumbnails).toEqual([]);

    const pending = repo.listPending();
    expect(pending).toHaveLength(2);

    expect(repo.markSent(n1.id)).toBe(true);
    expect(repo.markSent(n1.id)).toBe(false); // 幂等：已 SENT 不再返回 true
    expect(repo.listPending().map((n) => n.id)).toEqual([n2.id]);
    expect(repo.findById(n1.id)?.status).toBe('SENT');
    expect(repo.findById(n1.id)?.sentAt).not.toBeNull();
  });

  it('listPending 限制数量', () => {
    testDb = createTestDb();
    const tweets = new TweetRepository(testDb.app.db);
    const repo = new NotificationRepository(testDb.app.db);
    const tweet = tweets.create(tweetInput());
    for (let i = 0; i < 5; i += 1) {
      repo.create({ tweetId: tweet.id, text: `n${i}`, screenshotPath: null, videoThumbnails: [] });
    }
    expect(repo.listPending(3)).toHaveLength(3);
  });
});
