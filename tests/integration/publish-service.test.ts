import { afterEach, describe, expect, it, vi } from 'vitest';
import { BilibiliAuthError } from '../../src/bilibili/errors.js';
import type { TweetMedia } from '../../src/domain/tweet.js';
import { PublishStatus } from '../../src/domain/publish.js';
import { WorkflowStatus } from '../../src/domain/workflow.js';
import { TranslationRepository } from '../../src/repositories/translation-repository.js';
import { TweetRepository } from '../../src/repositories/tweet-repository.js';
import { DefaultPublishService } from '../../src/services/publish-service.js';
import { ValidationError } from '../../src/services/errors.js';
import { SqliteWorkflowService } from '../../src/services/workflow-service.js';
import { createRepositories } from '../../src/services/index.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;

afterEach(() => {
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

function photo(url: string): TweetMedia {
  return { type: 'photo', url, width: 1000, height: 800, alt: null };
}

function video(url: string): TweetMedia {
  return { type: 'video', url, thumbnail_url: url, width: 640, height: 360, alt: null };
}

function setup(media: TweetMedia[]) {
  testDb = createTestDb();
  const repos = createRepositories(testDb.app.db);
  const workflow = new SqliteWorkflowService(repos.tweets);
  const imageUploader = {
    uploadImage: vi.fn(async (_buf: Buffer, filename: string) => ({
      url: `https://i0.hdslb.com/bfs/article/${filename}`,
      width: 1280,
      height: 1406,
      sizeKb: 100,
    })),
  };
  const dynamicPublisher = {
    publishDynamic: vi.fn(async (input: { text: string; pics?: string[]; topicId?: string | null }) =>
      String(Math.floor(Math.random() * 1e9)),
    ),
  };
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.startsWith('https://pbs.twimg.com/')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response('nf', { status: 404 });
  });
  const service = new DefaultPublishService({
    tweets: repos.tweets,
    translations: repos.translations,
    topics: repos.topics,
    publishes: repos.publish,
    workflow,
    imageUploader,
    dynamicPublisher,
    fetchImpl,
  });
  return { repos, workflow, imageUploader, dynamicPublisher, service };
}

/** 建一条已翻译的推文（media 可选），返回 tweet id 与翻译。 */
function createTranslatedTweet(
  repos: ReturnType<typeof createRepositories>,
  options: { media?: TweetMedia[]; translation?: string; status?: WorkflowStatus } = {},
): number {
  const tweet = repos.tweets.create(
    tweetInput({ xTweetId: String(Date.now()), media: options.media ?? [] }),
  );
  const text = options.translation ?? '今天也辛苦啦～！🌸\n\n第二行';
  repos.translations.create(tweet.id, '10001', text, 1);
  repos.tweets.updateWorkflowStatus(tweet.id, options.status ?? WorkflowStatus.TRANSLATED);
  return tweet.id;
}

describe('DefaultPublishService（规格 §33-§39 / §53）', () => {
  it('没有翻译时拒绝发布（§34 需要最终翻译）', async () => {
    const { repos, service } = setup([]);
    const tweet = repos.tweets.create(tweetInput({ xTweetId: '100' }));
    await expect(service.publish(tweet.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it('图片推文发布成功：上传 photo、发布动态、记录 SUCCESS、状态 PUBLISHED', async () => {
    const { repos, imageUploader, dynamicPublisher, service } = setup([
      photo('https://pbs.twimg.com/media/a.jpg'),
      photo('https://pbs.twimg.com/media/c.jpg'),
    ]);
    const tweetId = createTranslatedTweet(repos, {
      media: [
        photo('https://pbs.twimg.com/media/a.jpg'),
        photo('https://pbs.twimg.com/media/c.jpg'),
      ],
      translation: '译文正文 🌸',
    });

    const result = await service.publish(tweetId);
    expect(result.published).toBe(true);
    expect(result.record.status).toBe(PublishStatus.SUCCESS);
    expect(result.record.biliDynamicId).toBeTruthy();
    expect(imageUploader.uploadImage).toHaveBeenCalledTimes(2);
    expect(dynamicPublisher.publishDynamic).toHaveBeenCalledWith({
      text: '译文正文 🌸',
      pics: [
        {
          url: 'https://i0.hdslb.com/bfs/article/a.jpg',
          width: 1280,
          height: 1406,
          sizeKb: 100,
        },
        {
          url: 'https://i0.hdslb.com/bfs/article/c.jpg',
          width: 1280,
          height: 1406,
          sizeKb: 100,
        },
      ],
      topicId: null,
      topicName: null,
    });
    expect(repos.tweets.findById(tweetId)?.workflowStatus).toBe(WorkflowStatus.PUBLISHED);
  });

  it('混合媒体只上传 photo，视频封面不上传（§21 / §53）', async () => {
    const { repos, imageUploader, dynamicPublisher, service } = setup([
      photo('https://pbs.twimg.com/media/a.jpg'),
      video('https://pbs.twimg.com/cover-b.jpg'),
      photo('https://pbs.twimg.com/media/c.jpg'),
    ]);
    const tweetId = createTranslatedTweet(repos, {
      media: [
        photo('https://pbs.twimg.com/media/a.jpg'),
        video('https://pbs.twimg.com/cover-b.jpg'),
        photo('https://pbs.twimg.com/media/c.jpg'),
      ],
    });

    await service.publish(tweetId);
    // 只有两张 photo 上传；视频封面不上传
    expect(imageUploader.uploadImage).toHaveBeenCalledTimes(2);
    const pics = dynamicPublisher.publishDynamic.mock.calls[0]?.[0].pics;
    expect(pics).toHaveLength(2);
    expect(pics?.some((p) => String(p?.url).includes('cover-b'))).toBe(false);
  });

  it('视频-only 推文：纯文本动态，pics 为空（§22）', async () => {
    const { repos, dynamicPublisher, service } = setup([video('https://pbs.twimg.com/cover.jpg')]);
    const tweetId = createTranslatedTweet(repos, {
      media: [video('https://pbs.twimg.com/cover.jpg')],
      translation: '只有翻译文本',
    });

    await service.publish(tweetId);
    expect(dynamicPublisher.publishDynamic).toHaveBeenCalledWith({
      text: '只有翻译文本',
      pics: [],
      topicId: null,
      topicName: null,
    });
  });

  it('幂等：已发布再次 publish 不调用 Bilibili（§38）', async () => {
    const { repos, imageUploader, dynamicPublisher, service } = setup([]);
    const tweetId = createTranslatedTweet(repos, { media: [] });

    const first = await service.publish(tweetId);
    expect(first.published).toBe(true);
    const second = await service.publish(tweetId);
    expect(second.published).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(imageUploader.uploadImage).toHaveBeenCalledTimes(0);
    expect(dynamicPublisher.publishDynamic).toHaveBeenCalledTimes(1);
    expect(service.isPublished(tweetId)).toBe(true);
  });

  it('发布失败：状态 PUBLISH_FAILED + lastError + FAILED 记录，错误传播', async () => {
    const { repos, imageUploader, service } = setup([photo('https://pbs.twimg.com/media/a.jpg')]);
    const tweetId = createTranslatedTweet(repos, {
      media: [photo('https://pbs.twimg.com/media/a.jpg')],
    });
    imageUploader.uploadImage.mockRejectedValue(new Error('Bilibili 上传超时'));

    await expect(service.publish(tweetId)).rejects.toThrow('Bilibili 上传超时');
    const tweet = repos.tweets.findById(tweetId);
    expect(tweet?.workflowStatus).toBe(WorkflowStatus.PUBLISH_FAILED);
    expect(tweet?.lastError).toContain('Bilibili 上传超时');
    const records = repos.publish.listByTweet(tweetId);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe(PublishStatus.FAILED);
    expect(records[0]?.attemptCount).toBe(1);
  });

  it('重试：PUBLISH_FAILED 后再次发布成功（§39）', async () => {
    const { repos, imageUploader, dynamicPublisher, service } = setup([
      photo('https://pbs.twimg.com/media/a.jpg'),
    ]);
    const tweetId = createTranslatedTweet(repos, {
      media: [photo('https://pbs.twimg.com/media/a.jpg')],
    });
    imageUploader.uploadImage.mockRejectedValueOnce(new Error('临时错误'));
    await expect(service.publish(tweetId)).rejects.toThrow('临时错误');

    const retried = await service.publish(tweetId);
    expect(retried.published).toBe(true);
    expect(dynamicPublisher.publishDynamic).toHaveBeenCalledTimes(1);
    expect(repos.tweets.findById(tweetId)?.workflowStatus).toBe(WorkflowStatus.PUBLISHED);
  });

  it('Cookie 失效：BilibiliAuthError 传播且状态进入 PUBLISH_FAILED（§54-18）', async () => {
    const { repos, imageUploader, service } = setup([photo('https://pbs.twimg.com/media/a.jpg')]);
    const tweetId = createTranslatedTweet(repos, {
      media: [photo('https://pbs.twimg.com/media/a.jpg')],
    });
    imageUploader.uploadImage.mockRejectedValue(
      new BilibiliAuthError('Bilibili 登录失效: 账号未登录', -101),
    );

    await expect(service.publish(tweetId)).rejects.toBeInstanceOf(BilibiliAuthError);
    const tweet = repos.tweets.findById(tweetId);
    expect(tweet?.workflowStatus).toBe(WorkflowStatus.PUBLISH_FAILED);
    expect(tweet?.lastError).toContain('登录失效');
  });

  it('话题：仅发布参数指定（已保存话题模型已移除，§33 新逻辑）', async () => {
    const { repos, dynamicPublisher, service } = setup([]);

    // 不带别名发布 → 无话题
    const tweetId = createTranslatedTweet(repos, { media: [] });
    await service.publish(tweetId);
    expect(dynamicPublisher.publishDynamic).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: null, topicName: null }),
    );

    // 带别名发布 → 从话题库解析（topicName 用别名占位）
    repos.topics.create({ alias: 'live', biliTopicId: '34567' });
    const tweetId2 = createTranslatedTweet(repos, { media: [] });
    await service.publish(tweetId2, 'live');
    expect(dynamicPublisher.publishDynamic).toHaveBeenLastCalledWith(
      expect.objectContaining({ topicId: '34567', topicName: 'live' }),
    );
  });

  it('未知话题拒绝发布', async () => {
    const { repos, service } = setup([]);
    const tweetId = createTranslatedTweet(repos, { media: [] });
    await expect(service.publish(tweetId, 'ghost')).rejects.toBeInstanceOf(ValidationError);
    expect(repos.tweets.findById(tweetId)?.workflowStatus).toBe(WorkflowStatus.TRANSLATED);
  });
});
