import { describe, expect, it, vi } from 'vitest';
import { TweetToasterClient } from '../../src/tweettoaster/client.ts';
import {
  TweetNotFoundError,
  TweetToasterError,
  TweetToasterUnavailableError,
} from '../../src/tweettoaster/errors.ts';
import { toasterResponse } from '../helpers/tweettoaster-fixtures.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 构造按 URL pathname 分发的 mock fetch。 */
function mockFetch(routes: Record<string, (init: RequestInit) => Response>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), BASE);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(prefix)) return handler(init ?? {});
    }
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });
}

const BASE = 'http://tweettoaster:8082';

describe('TweetToasterClient', () => {
  it('getTweet 成功返回标准化响应', async () => {
    const data = toasterResponse();
    const fetchImpl = mockFetch({
      '/api/tweet': () => jsonResponse(200, data),
    });
    const client = new TweetToasterClient({ baseUrl: BASE, fetchImpl });

    const result = await client.getTweet('https://x.com/example/status/1890000000000000000');
    expect(result.id).toBe(data.id);
    expect(result.mode).toBe('conversation');
    expect(result.tweets[0]?.text).toBe('今日も頑張る！🌸');
    // 请求体包含 url
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { url: string };
    expect(body.url).toContain('status/');
  });

  it('getTimeline 传入 @用户名', async () => {
    const fetchImpl = mockFetch({
      '/api/tweet': () => jsonResponse(200, toasterResponse({ mode: 'timeline' })),
    });
    const client = new TweetToasterClient({ baseUrl: BASE, fetchImpl });
    await client.getTimeline('example');
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { url: string };
    expect(body.url).toBe('@example');
  });

  it('404 → TweetNotFoundError（Phase 5 SOURCE_DELETED 信号）', async () => {
    const fetchImpl = mockFetch({
      '/api/tweet': () =>
        jsonResponse(404, { error: { code: 'TWEET_NOT_FOUND', message: '推文不存在、已删除或暂时无法读取' } }),
    });
    const client = new TweetToasterClient({ baseUrl: BASE, fetchImpl });
    await expect(client.getTweet('https://x.com/a/status/1')).rejects.toBeInstanceOf(
      TweetNotFoundError,
    );
  });

  it('200 但 provider 语义失败（code 非 200）→ TweetNotFoundError', async () => {
    // TweetToaster 对 payload.code !== 200 会抛 404；此处模拟其内部语义被透传的情况
    const fetchImpl = mockFetch({
      '/api/tweet': () =>
        jsonResponse(404, { error: { code: 'TWEET_NOT_FOUND', message: 'tweet not found' } }),
    });
    const client = new TweetToasterClient({ baseUrl: BASE, fetchImpl });
    await expect(client.getTweet('https://x.com/a/status/1')).rejects.toMatchObject({
      name: 'TweetNotFoundError',
      status: 404,
    });
  });

  it('连接失败 → TweetToasterUnavailableError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new TweetToasterClient({ baseUrl: BASE, fetchImpl });
    await expect(client.getTweet('x')).rejects.toBeInstanceOf(TweetToasterUnavailableError);
  });

  it('超时 → TweetToasterUnavailableError', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    });
    const client = new TweetToasterClient({
      baseUrl: BASE,
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(client.getTweet('x')).rejects.toBeInstanceOf(TweetToasterUnavailableError);
  });

  it('render 轮询任务：SUCCESS 返回 /cache 图片 URL', async () => {
    let pollCount = 0;
    const fetchImpl = mockFetch({
      '/api/render': () => jsonResponse(200, { task_id: 'task-1' }),
      '/api/get_task=task-1': () => {
        pollCount += 1;
        return jsonResponse(200, {
          task_id: 'task-1',
          state: pollCount >= 2 ? 'SUCCESS' : 'PENDING',
          result: '1780000000000-abc123.png',
        });
      },
    });
    const client = new TweetToasterClient({
      baseUrl: BASE,
      fetchImpl,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });
    const url = await client.render({
      tweet: 'https://x.com/a/status/1',
      selection: [{ id: '1' }],
      template: '',
      logo: 'none',
    });
    expect(url).toBe(`${BASE}/cache/1780000000000-abc123.png`);
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it('render 任务 FAILURE 抛错', async () => {
    const fetchImpl = mockFetch({
      '/api/render': () => jsonResponse(200, { task_id: 'task-fail' }),
      '/api/get_task=task-fail': () =>
        jsonResponse(200, {
          task_id: 'task-fail',
          state: 'FAILURE',
          result: null,
          error: '渲染失败',
        }),
    });
    const client = new TweetToasterClient({
      baseUrl: BASE,
      fetchImpl,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });
    await expect(
      client.render({ tweet: 'https://x.com/a/status/1', selection: [{ id: '1' }] }),
    ).rejects.toThrow(/渲染失败/);
  });

  it('任务轮询超时抛错', async () => {
    const fetchImpl = mockFetch({
      '/api/render': () => jsonResponse(200, { task_id: 'task-slow' }),
      '/api/get_task=task-slow': () =>
        jsonResponse(200, { task_id: 'task-slow', state: 'STARTED', result: null }),
    });
    const client = new TweetToasterClient({
      baseUrl: BASE,
      fetchImpl,
      pollIntervalMs: 5,
      pollTimeoutMs: 50,
    });
    await expect(
      client.render({ tweet: 'https://x.com/a/status/1', selection: [{ id: '1' }] }),
    ).rejects.toBeInstanceOf(TweetToasterError);
  });

  it('health：正常返回版本，不可达返回 null', async () => {
    const ok = new TweetToasterClient({
      baseUrl: BASE,
      fetchImpl: mockFetch({ '/api/health': () => jsonResponse(200, { status: 'ok', version: '2.0.0' }) }),
    });
    await expect(ok.health()).resolves.toEqual({ status: 'ok', version: '2.0.0' });

    const down = new TweetToasterClient({
      baseUrl: BASE,
      fetchImpl: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    await expect(down.health()).resolves.toBeNull();
  });
});
