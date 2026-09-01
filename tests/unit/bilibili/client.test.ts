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
function mockFetch(routes: Record<string, (init: RequestInit, url: string) => Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (key.startsWith(prefix)) return handler(init ?? {}, key);
    }
    return jsonResponse({ code: -404, message: 'not found' });
  });
}

describe('BilibiliClient（规格 §36 / §40）', () => {
  it('uploadImage 成功：带 Cookie、multipart file_up，返回图片信息', async () => {
    let uploadInit: RequestInit | undefined;
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () => jsonResponse(NAV_OK),
      'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs': (init) => {
        uploadInit = init;
        return jsonResponse({
          code: 0,
          message: '0',
          data: {
            image_url: 'https://i0.hdslb.com/bfs/article/x.jpg',
            image_width: 1280,
            image_height: 1406,
            img_size: 1070.6,
          },
        });
      },
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });

    const uploaded = await client.uploadImage(Buffer.from([1, 2, 3]), 'a.jpg');
    expect(uploaded).toEqual({
      url: 'https://i0.hdslb.com/bfs/article/x.jpg',
      width: 1280,
      height: 1406,
      sizeKb: 1070.6,
    });

    // 上传请求带 cookie 与 multipart file_up
    const headers = uploadInit?.headers as Record<string, string> | undefined;
    expect(headers?.cookie).toContain('SESSDATA=s');
    expect(headers?.cookie).toContain('bili_jct=j');
    expect(headers?.cookie).toContain('DedeUserID=1');
    const body = uploadInit?.body;
    expect(body).toBeInstanceOf(FormData);
    const file = (body as FormData).get('file_up');
    expect((file as File | null)?.name).toBe('a.jpg');
    expect((body as FormData).get('category')).toBe('daily');
    expect((body as FormData).get('csrf')).toBe('j');
  });

  it('wbi key 缓存：多次动态发布只拉取一次 nav', async () => {
    const nav = vi.fn(() => jsonResponse(NAV_OK));
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': nav,
      'https://api.bilibili.com/x/dynamic/feed/create/dyn': () =>
        jsonResponse({ code: 0, message: '0', data: { dyn_id_str: '1' } }),
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });
    await client.publishDynamic({ text: 'a' });
    await client.publishDynamic({ text: 'b' });
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it('publishDynamic 成功：JSON dyn_req 含文本/图片/话题，返回动态 ID', async () => {
    let createInit: RequestInit | undefined;
    let createUrl = '';
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () => jsonResponse(NAV_OK),
      'https://api.bilibili.com/x/dynamic/feed/create/dyn': (init, url) => {
        createInit = init;
        createUrl = String(url);
        return jsonResponse({ code: 0, message: '0', data: { dyn_id_str: '123456' } });
      },
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });

    const dynamicId = await client.publishDynamic({
      text: '今天也辛苦啦～！🌸',
      pics: [
        { url: 'https://i0.hdslb.com/bfs/article/a.jpg', width: 1280, height: 1406, sizeKb: 100 },
      ],
      topicId: '23456',
      topicName: 'hololive',
    });
    expect(dynamicId).toBe('123456');

    // wbi 签名参数在 query
    expect(createUrl).toContain('csrf=j');
    expect(createUrl).toContain('w_rid=');
    expect(createUrl).toContain('wts=');

    const body = JSON.parse(String(createInit?.body)) as {
      dyn_req: {
        content: { contents: { raw_text: string }[] };
        scene: number;
        pics: { img_src: string; img_width: number }[];
        topic: { id: number; name: string };
      };
    };
    expect(body.dyn_req.content.contents[0]?.raw_text).toBe('今天也辛苦啦～！🌸');
    expect(body.dyn_req.scene).toBe(2);
    expect(body.dyn_req.pics[0]).toMatchObject({
      img_src: 'https://i0.hdslb.com/bfs/article/a.jpg',
      img_width: 1280,
    });
    expect(body.dyn_req.topic).toMatchObject({ id: 23456, name: 'hololive' });
  });

  it('完整 Cookie 串优先：hasCookie 为真，请求头带完整串（含指纹）', async () => {
    const cookieString =
      'SESSDATA=s; bili_jct=j; DedeUserID=1; buvid3=abc123; b_nut=1700000000; b_lsid=xyz';
    let uploadInit: RequestInit | undefined;
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () => jsonResponse(NAV_OK),
      'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs': (init) => {
        uploadInit = init;
        return jsonResponse({
          code: 0,
          message: '0',
          data: {
            image_url: 'https://i0.hdslb.com/bfs/article/x.jpg',
            image_width: 1280,
            image_height: 1406,
            img_size: 100,
          },
        });
      },
    });
    // 三件套为空也视为已配置（完整串优先）
    const client = new BilibiliClient({
      cookie: { sessdata: '', jct: '', dedeuserid: '' },
      cookieString,
      fetchImpl,
    });
    expect(client.hasCookie()).toBe(true);

    await client.uploadImage(Buffer.from([1]), 'a.jpg');
    const headers = uploadInit?.headers as Record<string, string> | undefined;
    expect(headers?.cookie).toBe(cookieString);
    // 浏览器风格头存在
    expect(headers?.['sec-ch-ua']).toContain('Chromium');
    expect(headers?.['sec-fetch-mode']).toBe('cors');
    expect(headers?.origin).toBe('https://t.bilibili.com');
    expect(headers?.['user-agent']).toContain('Chrome/126');
  });

  it('登录失效：业务 code -101 → BilibiliAuthError（§54-18 Cookie 过期）', async () => {
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs': () =>
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
      'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs': () =>
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
