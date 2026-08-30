import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TweetMedia } from '../../src/domain/tweet.js';
import { TweetRepository } from '../../src/repositories/tweet-repository.js';
import { DefaultMediaService } from '../../src/services/media-service.js';
import { NotFoundError } from '../../src/services/errors.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

let testDb: TestDb | null = null;
let tmpDir = '';

afterEach(() => {
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

/** 按 URL 返回不同 Content-Type 的 mock fetch。 */
function mediaFetch(routes: Record<string, { type: string; bytes?: Uint8Array }>) {
  return vi.fn(async (url: string) => {
    for (const [prefix, item] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return new Response(item.bytes ?? new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': item.type },
        });
      }
    }
    return new Response('not found', { status: 404 });
  });
}

function mixedMedia(): TweetMedia[] {
  return [
    { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1000, height: 800, alt: null },
    {
      type: 'video',
      url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/b.jpg',
      thumbnail_url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/b.jpg',
      width: 640,
      height: 360,
      alt: null,
    },
    { type: 'photo', url: 'https://pbs.twimg.com/media/c.webp', width: 1000, height: 800, alt: null },
    {
      type: 'gif',
      url: 'https://pbs.twimg.com/ext_tw_video_thumb/2/pu/img/d.jpg',
      thumbnail_url: 'https://pbs.twimg.com/ext_tw_video_thumb/2/pu/img/d.jpg',
      width: 480,
      height: 270,
      alt: null,
    },
  ];
}

describe('DefaultMediaService（规格 §16 / §18 / §21 / §47）', () => {
  it('photo 与视频封面严格分离缓存（三种资产）', async () => {
    testDb = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-media-'));
    const repo = new TweetRepository(testDb.app.db);
    const tweet = repo.create(tweetInput({ media: mixedMedia() }));

    const fetchImpl = mediaFetch({
      'https://pbs.twimg.com/media/a.jpg': { type: 'image/jpeg' },
      'https://pbs.twimg.com/media/c.webp': { type: 'image/webp' },
      'https://pbs.twimg.com/ext_tw_video_thumb/1': { type: 'image/jpeg' },
      'https://pbs.twimg.com/ext_tw_video_thumb/2': { type: 'image/jpeg' },
    });
    const service = new DefaultMediaService({ tweets: repo, cacheRoot: tmpDir, fetchImpl });

    const photos = await service.cachePhotos(tweet.id);
    const covers = await service.cacheVideoThumbnails(tweet.id);

    // photo 只缓存 photo（规格 §21），扩展名按 Content-Type
    expect(photos).toEqual([
      path.join(tmpDir, 'twitter-photos', String(tweet.id), '0.jpg'),
      path.join(tmpDir, 'twitter-photos', String(tweet.id), '1.webp'),
    ]);
    // 视频封面只缓存 video/gif 的封面
    expect(covers).toEqual([
      path.join(tmpDir, 'video-thumbnails', String(tweet.id), '0.jpg'),
      path.join(tmpDir, 'video-thumbnails', String(tweet.id), '1.jpg'),
    ]);
    for (const file of [...photos, ...covers]) {
      expect(fs.existsSync(file)).toBe(true);
    }
    // 视频封面不进入 twitter-photos
    expect(fs.readdirSync(path.join(tmpDir, 'twitter-photos', String(tweet.id)))).toHaveLength(2);
    // 视频本体不下载：mock 中没有视频 URL 路由
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).not.toContain(
      'https://video.twimg.com/x.mp4',
    );
  });

  it('无媒体时返回空数组', async () => {
    testDb = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-media-'));
    const repo = new TweetRepository(testDb.app.db);
    const tweet = repo.create(tweetInput({ media: [] }));
    const service = new DefaultMediaService({
      tweets: repo,
      cacheRoot: tmpDir,
      fetchImpl: mediaFetch({}),
    });
    expect(await service.cachePhotos(tweet.id)).toEqual([]);
    expect(await service.cacheVideoThumbnails(tweet.id)).toEqual([]);
  });

  it('推文不存在抛 NotFoundError', async () => {
    testDb = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-media-'));
    const repo = new TweetRepository(testDb.app.db);
    const service = new DefaultMediaService({
      tweets: repo,
      cacheRoot: tmpDir,
      fetchImpl: mediaFetch({}),
    });
    await expect(service.cachePhotos(9999)).rejects.toBeInstanceOf(NotFoundError);
  });
});
