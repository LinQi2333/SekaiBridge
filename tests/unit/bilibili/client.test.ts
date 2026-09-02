import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    // csrf 从完整 Cookie 串解析（三件套为空也能拿到 bili_jct）
    expect((uploadInit?.body as FormData).get('csrf')).toBe('j');
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

  it('checkSession：nav isLogin 判断登录态；cookie/info 提示刷新', async () => {
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () =>
        jsonResponse({ code: 0, message: '0', data: { isLogin: true, uname: '某资讯站' } }),
      'https://passport.bilibili.com/x/passport-login/web/cookie/info': () =>
        jsonResponse({ code: 0, message: '0', data: { refresh: false, timestamp: 0 } }),
    });
    const client = new BilibiliClient({ cookie: COOKIE, fetchImpl });
    await expect(client.checkSession()).resolves.toMatchObject({
      loggedIn: true,
      uname: '某资讯站',
      refreshNeeded: false,
    });
  });

  it('refreshTicket：签名参数正确 + 更新 bili_ticket 并持久化到文件', async () => {
    const FULL = 'SESSDATA=s; bili_jct=j; DedeUserID=1; bili_ticket=old; bili_ticket_expires=1';
    let ticketUrl = '';
    const fetchImpl = mockFetch({
      'https://api.bilibili.com/x/web-interface/nav': () => jsonResponse(NAV_OK),
      'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket': (_init, url) => {
        ticketUrl = String(url);
        return jsonResponse({
          code: 0,
          message: 'OK',
          data: { ticket: 'new-ticket-value', created_at: 1000, ttl: 259200 },
        });
      },
    });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-cookie-')), 'cookies.json');
    const client = new BilibiliClient({ cookie: COOKIE, cookieString: FULL, cookieFile: file, fetchImpl });

    const result = await client.refreshTicket();
    expect(result).toEqual({ ticket: 'new-ticket-value', expiresAt: 260200 });
    expect(ticketUrl).toContain('key_id=ec02');
    expect(ticketUrl).toMatch(/hexsign=[0-9a-f]{64}/);
    expect(ticketUrl).toContain('csrf=j');

    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { cookieString: string };
    expect(saved.cookieString).toContain('bili_ticket=new-ticket-value');
    expect(saved.cookieString).toContain('bili_ticket_expires=260200');
    expect(saved.cookieString).toContain('SESSDATA=s');
  });

  it('cookie 文件优先于 env：续期结果跨重启保留', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-cookie-')), 'cookies.json');
    // 首次：env 初值写入文件
    new BilibiliClient({
      cookie: COOKIE,
      cookieString: 'SESSDATA=s; bili_jct=j; DedeUserID=1',
      cookieFile: file,
      fetchImpl: vi.fn(),
    });
    expect(fs.existsSync(file)).toBe(true);
    // 模拟续期后文件内容
    fs.writeFileSync(
      file,
      JSON.stringify({ cookieString: 'SESSDATA=s; bili_jct=j; DedeUserID=1; bili_ticket=stored' }),
    );
    // 新实例（env 无 ticket）读到文件里的 stored
    const client = new BilibiliClient({
      cookie: COOKIE,
      cookieString: 'SESSDATA=s; bili_jct=j; DedeUserID=1',
      cookieFile: file,
      fetchImpl: vi.fn(),
    });
    expect(client.hasCookie()).toBe(true);
    // 通过一次带 cookie 的请求验证内部用的是文件值
    let sentCookie = '';
    const fetchImpl2 = mockFetch({
      'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs': (init) => {
        sentCookie = String((init.headers as Record<string, string>).cookie);
        return jsonResponse({
          code: 0,
          message: '0',
          data: { image_url: 'https://i0.hdslb.com/bfs/article/x.jpg', image_width: 1, image_height: 1, img_size: 1 },
        });
      },
    });
    const client2 = new BilibiliClient({
      cookie: COOKIE,
      cookieString: 'SESSDATA=s; bili_jct=j; DedeUserID=1',
      cookieFile: file,
      fetchImpl: fetchImpl2,
    });
    await client2.uploadImage(Buffer.from([1]), 'a.jpg'); // 触发 nav(wbi) 请求
    expect(sentCookie).toContain('bili_ticket=stored');
  });
});
