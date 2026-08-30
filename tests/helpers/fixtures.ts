import type { NewTweetInput } from '../../src/domain/tweet.js';

/** 构造标准化推文输入（模拟 TweetToaster 输出）。 */
export function tweetInput(overrides: Partial<NewTweetInput> = {}): NewTweetInput {
  return {
    xTweetId: '1890000000000000000',
    authorScreenName: 'example',
    authorName: 'Example Channel',
    tweetUrl: 'https://x.com/example/status/1890000000000000000',
    originalText: '今日も頑張る！🌸😭\n\n第二行',
    createdAtX: '2026-08-30T02:15:00.000Z',
    media: [],
    rawJson: { id: '1890000000000000000' },
    ...overrides,
  };
}
