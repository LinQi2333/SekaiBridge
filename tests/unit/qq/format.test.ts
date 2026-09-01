import { describe, expect, it } from 'vitest';
import { WorkflowStatus } from '../../../src/domain/workflow.js';
import type { Tweet } from '../../../src/domain/tweet.js';
import {
  formatNewTweetNotification,
  formatTopicList,
  formatTranslationSaved,
  formatTweetListLine,
  formatTweetView,
  sourceLabel,
  toDisplayTime,
  workflowLabel,
} from '../../../src/qq/format.js';

function makeTweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: 152,
    seq: 152,
    xTweetId: '1890000000000000000',
    authorScreenName: 'example',
    authorName: 'Example Channel',
    tweetUrl: 'https://x.com/example/status/1890000000000000000',
    originalText: '今天的秘密原文内容绝对不出现在 QQ',
    createdAtX: '2026-08-30T02:15:00.000Z',
    detectedAt: '2026-08-30T02:16:00.000Z',
    rawJson: null,
    mediaJson: null,
    screenshotPath: null,
    workflowStatus: WorkflowStatus.WAITING_TRANSLATION,
    sourceStatus: 'ACTIVE',
    lastError: null,
    retryCount: 0,
    createdAt: '2026-08-30T02:16:00.000Z',
    updatedAt: '2026-08-30T02:16:00.000Z',
    ...overrides,
  };
}

describe('QQ 展示格式化（规格 §42 / §27 / §51）', () => {
  it('新推文通知：包含 id/账号/时间/状态/URL，绝不包含原文正文', () => {
    const text = formatNewTweetNotification(makeTweet());
    expect(text).toContain('【新推文 #152】');
    expect(text).toContain('账号：@example');
    expect(text).toContain('时间：');
    expect(text).toContain('状态：待翻译');
    expect(text).toContain('原推：');
    expect(text).toContain('https://x.com/example/status/1890000000000000000');
    expect(text).not.toContain('秘密原文');
    expect(text).not.toContain('今天的秘密原文内容');
  });

  it('视频推文通知：追加"包含视频"提示（规格 §18 / §42 视频版）', () => {
    const tweet = makeTweet({
      mediaJson: JSON.stringify([
        { type: 'video', url: 'https://pbs.twimg.com/cover.jpg', thumbnail_url: 'https://pbs.twimg.com/cover.jpg' },
      ]),
    });
    const text = formatNewTweetNotification(tweet);
    expect(text).toContain('⚠️ 此推文包含视频。');
    expect(text).toContain('视频本体不会下载或转载');
    expect(text).not.toContain('秘密原文');
  });

  it('普通图片推文通知：不出现视频提示', () => {
    const text = formatNewTweetNotification(makeTweet());
    expect(text).not.toContain('包含视频');
  });

  it('/查看 输出：状态 + 原推链接，不含原文正文（规格 §27 / §51）', () => {
    const text = formatTweetView(makeTweet());
    expect(text).toContain('#152');
    expect(text).toContain('@example');
    expect(text).toContain('来源状态：正常');
    expect(text).toContain('工作状态：待翻译');
    expect(text).toContain('https://x.com/example/status/1890000000000000000');
    expect(text).not.toContain('秘密原文');
  });

  it('/查看 显示原推已删除（规格 §13）', () => {
    const text = formatTweetView(makeTweet({ sourceStatus: 'SOURCE_DELETED' }));
    expect(text).toContain('来源状态：⚠️ 原推已删除');
  });

  it('/列表 单行格式（规格 §26）', () => {
    expect(formatTweetListLine(makeTweet())).toBe('#152 @example   待翻译');
    expect(formatTweetListLine(makeTweet({ sourceStatus: 'SOURCE_DELETED' }))).toBe(
      '#152 @example   原推已删除 / 待翻译',
    );
  });

  it('状态与时间标签', () => {
    expect(workflowLabel('PUBLISH_FAILED')).toBe('发布失败');
    expect(sourceLabel('SOURCE_DELETED')).toBe('⚠️ 原推已删除');
    expect(toDisplayTime('2026-08-30T02:15:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(toDisplayTime(null)).toBe('未知');
    // SQLite 无时区标记的 UTC 时间（"YYYY-MM-DD HH:MM:SS"）与带 Z 的同一时刻展示一致
    expect(toDisplayTime('2026-08-30 02:15:00')).toBe(toDisplayTime('2026-08-30T02:15:00.000Z'));
    expect(toDisplayTime('not-a-date')).toBe('未知');
  });

  it('翻译保存回复（规格 §30）', () => {
    const text = formatTranslationSaved(152, 3);
    expect(text).toContain('推文 #152 翻译已保存。');
    expect(text).toContain('当前版本：v3');
    expect(text).toContain('状态：已翻译，等待发布。');
    expect(text).toContain('/发布 152 [话题别名]');
  });

  it('话题列表（规格 §31）', () => {
    const text = formatTopicList([
      { alias: 'hololive', biliTopicId: '23456' },
      { alias: 'live', biliTopicId: '34567' },
    ]);
    expect(text).toContain('可用话题：');
    expect(text).toContain('hololive（#23456）');
    expect(text).toContain('live（#34567）');
  });
});
