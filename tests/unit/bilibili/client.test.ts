import { describe, expect, it, vi } from 'vitest';
import { BilibiliClient } from '../../../src/bilibili/client.js';
import {
  BilibiliApiError,
  BilibiliAuthError,
  BilibiliNetworkError,
} from '../../../src/bilibili/errors.js';

const COOKIE = { sessdata: 's', jct: 'j', dedeuserid: '1' };

const NAV_OK = {
  code: 0,
  message: '0',
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 按 URL 分发的 mock fetch。 */
function mockFetch(routes: Record<string, (init: RequestInit) => Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (key.startsWith(prefix)) return handler(init ?? {});
    }
    return jsonResponse({ code: -404, message: 'not found' });
  });
}

describe('BilibiliClient（规格 §36 / §40）', () => {
  it('uploadImage 成功：带 Cookie、multipart file、返回图片 URL', async () => {
    let uploadInit: RequestInit | undefined;
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () => jsonResponse(NAV_OK),
      'https://api.vc.bilibili.com/api/v1/web/image': (init) => {
        uploadInit = init;
        return jsonResponse({ code: 0, message: '0', data: { image_url: 'https://i0.hdslb.com/bfs/article/x.jpg' } });
      },
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });

    const url = await client.uploadImage(Buffer.from([1, 2, 3]), 'a.jpg');
    expect(url).toBe('https://i0.hdslb.com/bfs/article/x.jpg');

    // 上传请求带 cookie 与 multipart file
    const headers = uploadInit?.headers as Record<string, string> | undefined;
    expect(headers?.cookie).toContain('SESSDATA=s');
    expect(headers?.cookie).toContain('bili_jct=j');
    expect(headers?.cookie).toContain('DedeUserID=1');
    const body = uploadInit?.body;
    expect(body).toBeInstanceOf(FormData);
    const file = (body as FormData).get('file');
    expect((file as File | null)?.name).toBe('a.jpg');
    // wbi 签名参数存在
    expect((body as FormData).has('w_rid')).toBe(true);
    expect((body as FormData).has('wts')).toBe(true);
  });

  it('wbi key 缓存：多次请求只拉取一次 nav', async () => {
    const nav = vi.fn(() => jsonResponse(NAV_OK));
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': nav,
      'https://api.vc.bilibili.com/api/v1/web/image': () =>
        jsonResponse({ code: 0, message: '0', data: { image_url: 'u' } }),
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });
    await client.uploadImage(Buffer.from([1]), 'a.jpg');
    await client.uploadImage(Buffer.from([2]), 'b.jpg');
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it('publishDynamic 成功：form 含 type/biz_id/content/csrf，返回动态 ID', async () => {
    let createInit: RequestInit | undefined;
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () => jsonResponse(NAV_OK),
      'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create': (init) => {
        createInit = init;
        return jsonResponse({ code: 0, message: '0', data: { dynamic_id: 123456 } });
      },
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });

    const dynamicId = await client.publishDynamic({
      text: '今天也辛苦啦～！🌸',
      pics: ['https://i0.hdslb.com/bfs/article/a.jpg'],
      topicId: '23456',
    });
    expect(dynamicId).toBe('123456');

    const body = createInit?.body as FormData;
    expect(body.get('type')).toBe('4');
    expect(body.get('biz_id')).toBe(JSON.stringify(['https://i0.hdslb.com/bfs/article/a.jpg']));
    expect(body.get('content')).toBe('今天也辛苦啦～！🌸');
    expect(body.get('topic_id')).toBe('23456');
    expect(body.get('csrf')).toBe('j');
  });

  it('登录失效：业务 code -101 → BilibiliAuthError（§54-18 Cookie 过期）', async () => {
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () =>
        jsonResponse({ code: -101, message: '账号未登录' }),
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });
    await expect(client.uploadImage(Buffer.from([1]), 'a.jpg')).rejects.toBeInstanceOf(
      BilibiliAuthError,
    );
  });

  it('上传接口返回业务错误 → BilibiliApiError', async () => {
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () => jsonResponse(NAV_OK),
      'https://api.vc.bilibili.com/api/v1/web/image': () =>
        jsonResponse({ code: -400, message: '请求错误' }),
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });
    await expect(client.uploadImage(Buffer.from([1]), 'a.jpg')).rejects.toBeInstanceOf(
      BilibiliApiError,
    );
  });

  it('未配置 Cookie → BilibiliAuthError', async () => {
    const client = new BilibiliClient({ cookie: { sessdata: '', jct: '', dedeuserid: '' } });
    await expect(client.uploadImage(Buffer.from([1]), 'a.jpg')).rejects.toBeInstanceOf(
      BilibiliAuthError,
    );
    expect(client.hasCookie()).toBe(false);
  });

  it('网络错误 → BilibiliNetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });
    await expect(client.publishDynamic({ text: 'x' })).rejects.toBeInstanceOf(BilibiliNetworkError);
  });
});
