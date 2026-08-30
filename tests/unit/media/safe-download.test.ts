import { describe, expect, it, vi } from 'vitest';
import {
  EXT_BY_CONTENT_TYPE,
  normalizeContentType,
  safeDownload,
} from '../../../src/media/safe-download.js';
import { MediaDownloadError } from '../../../src/media/media-download-error.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function imageResponse(body: Uint8Array, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('safeDownload（规格 §48 媒体安全）', () => {
  it('成功下载并返回归一化 Content-Type', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(PNG, 'image/png'));
    const result = await safeDownload('https://pbs.twimg.com/media/a.png', { fetchImpl });
    expect(result.contentType).toBe('image/png');
    expect(result.bytes).toEqual(PNG);
  });

  it('拒绝非 HTTP/HTTPS 协议（file:// 等）', async () => {
    await expect(safeDownload('file:///etc/passwd')).rejects.toMatchObject({ code: 'BAD_PROTOCOL' });
    await expect(safeDownload('ftp://x.com/a.png')).rejects.toMatchObject({ code: 'BAD_PROTOCOL' });
  });

  it('拒绝不在白名单的 Content-Type', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(Buffer.from('<script>'), 'text/html'));
    await expect(
      safeDownload('https://x.com/a.png', { fetchImpl }),
    ).rejects.toMatchObject({ code: 'BAD_CONTENT_TYPE' });
  });

  it('超过大小限制抛 TOO_LARGE（Content-Length 预检）', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(PNG, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(1024 * 1024) },
        }),
    );
    await expect(
      safeDownload('https://x.com/a.png', { fetchImpl, maxBytes: 100 }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('实际字节超过限制抛 TOO_LARGE', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(PNG, 'image/png'));
    await expect(
      safeDownload('https://x.com/a.png', { fetchImpl, maxBytes: 2 }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('HTTP 错误抛 HTTP_ERROR', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(safeDownload('https://x.com/a.png', { fetchImpl })).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 404,
    });
  });

  it('连接失败抛 FETCH_FAILED，超时抛 TIMEOUT', async () => {
    const broken = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(safeDownload('https://x.com/a.png', { fetchImpl: broken })).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    });

    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    await expect(
      safeDownload('https://x.com/a.png', { fetchImpl: hanging, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('Content-Type 归一化与扩展名映射', () => {
    expect(normalizeContentType('image/jpeg; charset=utf-8')).toBe('image/jpeg');
    expect(normalizeContentType('image/jpg')).toBe('image/jpeg');
    expect(normalizeContentType(null)).toBe('');
    expect(EXT_BY_CONTENT_TYPE['image/jpeg']).toBe('jpg');
    expect(EXT_BY_CONTENT_TYPE['image/webp']).toBe('webp');
  });

  it('错误类型可 instanceof 判断', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(Buffer.from('<script>'), 'text/html'));
    try {
      await safeDownload('https://x.com/a.png', { fetchImpl });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MediaDownloadError);
    }
  });
});
