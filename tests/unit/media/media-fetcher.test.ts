import { describe, expect, it, vi } from 'vitest';
import { createMediaFetcher, isTwitterMediaUrl } from '../../../src/media/media-fetcher.js';

describe('媒体获取策略（TweetToaster 代理）', () => {
  it('识别 Twitter 媒体域名', () => {
    expect(isTwitterMediaUrl('https://pbs.twimg.com/media/a.jpg')).toBe(true);
    expect(isTwitterMediaUrl('https://video.twimg.com/ext_tw_video/x.mp4')).toBe(true);
    expect(isTwitterMediaUrl('https://i0.hdslb.com/bfs/article/a.jpg')).toBe(false);
    expect(isTwitterMediaUrl('not a url')).toBe(false);
  });

  it('Twitter 媒体走 TweetToaster /api/media 代理', async () => {
    const proxy = {
      downloadMedia: vi.fn(async () => ({ bytes: Buffer.from([1]), contentType: 'image/jpeg' })),
    };
    const fetcher = createMediaFetcher(proxy);
    const result = await fetcher('https://pbs.twimg.com/media/a.jpg');
    expect(result.contentType).toBe('image/jpeg');
    expect(proxy.downloadMedia).toHaveBeenCalledWith('https://pbs.twimg.com/media/a.jpg');
  });

  it('非 Twitter 媒体直连（不走代理）', async () => {
    const proxy = { downloadMedia: vi.fn() };
    const direct = vi.fn(async () =>
      new Response(new Uint8Array([2]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const fetcher = createMediaFetcher(proxy, { fetchImpl: direct as unknown as typeof fetch });
    const result = await fetcher('https://i0.hdslb.com/bfs/article/a.png');
    expect(result.bytes).toEqual(Buffer.from([2]));
    expect(result.contentType).toBe('image/png');
    expect(proxy.downloadMedia).not.toHaveBeenCalled();
  });

  it('未提供代理时全部直连', async () => {
    const direct = vi.fn(async () =>
      new Response(new Uint8Array([3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    const fetcher = createMediaFetcher(undefined, { fetchImpl: direct as unknown as typeof fetch });
    const result = await fetcher('https://pbs.twimg.com/media/a.jpg');
    expect(direct.mock.calls[0]?.[0]).toBe('https://pbs.twimg.com/media/a.jpg');
    expect(result.bytes).toEqual(Buffer.from([3]));
  });
});
