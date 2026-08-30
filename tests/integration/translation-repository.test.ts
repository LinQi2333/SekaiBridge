import { afterEach, describe, expect, it } from 'vitest';
import { TranslationRepository } from '../../src/repositories/translation-repository.js';
import { TweetRepository } from '../../src/repositories/tweet-repository.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;
let translations: TranslationRepository | null = null;

afterEach(() => {
  translations = null;
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

describe('TranslationRepository（规格 §29）', () => {
  it('版本号从 1 递增，最新版本为当前有效版本', () => {
    testDb = createTestDb();
    translations = new TranslationRepository(testDb.app.db);
    const tweets = new TweetRepository(testDb.app.db);
    const tweet = tweets.create(tweetInput());

    expect(translations.nextVersion(tweet.id)).toBe(1);
    const v1 = translations.create(tweet.id, '10001', '第一版', 1);
    const v2 = translations.create(tweet.id, '10001', '第二版 🌸', 2);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(translations.nextVersion(tweet.id)).toBe(3);

    expect(translations.findLatest(tweet.id)?.version).toBe(2);
    expect(translations.findLatest(tweet.id)?.text).toBe('第二版 🌸');

    const all = translations.listByTweet(tweet.id);
    expect(all.map((t) => t.version)).toEqual([1, 2]);
  });

  it('保留 emoji / 换行 / 空行原文（规格 §49）', () => {
    testDb = createTestDb();
    translations = new TranslationRepository(testDb.app.db);
    const tweets = new TweetRepository(testDb.app.db);
    const tweet = tweets.create(tweetInput());

    const text = '今天也辛苦啦～！🌸😭🥹❤️✨\n\n(｡･ω･｡)\nhttps://example.com/a';
    translations.create(tweet.id, '10001', text, 1);
    expect(translations.findLatest(tweet.id)?.text).toBe(text);
  });
});
