import { afterEach, describe, expect, it } from 'vitest';
import { PublishStatus } from '../../src/domain/publish.js';
import { PublishRepository } from '../../src/repositories/publish-repository.js';
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

describe('PublishRepository（规格 §37 / §38）', () => {
  it('创建发布记录；同一推文只能有一条 SUCCESS（数据库级幂等）', () => {
    testDb = createTestDb();
    const tweets = new TweetRepository(testDb.app.db);
    const publishes = new PublishRepository(testDb.app.db);
    const tweet = tweets.create(tweetInput());

    const record = publishes.create({
      tweetId: tweet.id,
      translationId: null,
      status: PublishStatus.SUCCESS,
      biliDynamicId: '888888',
    });
    expect(record.status).toBe(PublishStatus.SUCCESS);
    expect(record.biliDynamicId).toBe('888888');
    expect(record.publishedAt).not.toBeNull();

    // 第二次成功发布必须被数据库拒绝
    expect(() =>
      publishes.create({ tweetId: tweet.id, translationId: null, status: PublishStatus.SUCCESS }),
    ).toThrow(/UNIQUE/i);

    expect(publishes.findSuccessfulByTweet(tweet.id)?.biliDynamicId).toBe('888888');
  });

  it('失败记录可以多条，attempt_count 递增', () => {
    testDb = createTestDb();
    const tweets = new TweetRepository(testDb.app.db);
    const publishes = new PublishRepository(testDb.app.db);
    const tweet = tweets.create(tweetInput());

    publishes.create({ tweetId: tweet.id, translationId: null, status: PublishStatus.FAILED, lastError: '网络错误' });
    const second = publishes.appendFailure(tweet.id, 'cookie 失效');
    expect(second.status).toBe(PublishStatus.FAILED);
    expect(second.attemptCount).toBe(2);
    expect(second.lastError).toBe('cookie 失效');
    expect(publishes.listByTweet(tweet.id)).toHaveLength(2);
    expect(publishes.findSuccessfulByTweet(tweet.id)).toBeNull();
  });
});
