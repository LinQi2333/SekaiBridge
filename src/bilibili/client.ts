import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { BilibiliApiError, BilibiliAuthError, BilibiliNetworkError } from './errors.js';
import type { UploadedImage } from './image-upload.js';
import { extractKeyFromImageUrl, signWbi, type WbiSignResult } from './wbi.js';

/** Bilibili 登录 Cookie（规格 §40：只放 .env，禁止进入 Git/日志）。 */
export interface BilibiliCookie {
  sessdata: string;
  jct: string;
  dedeuserid: string;
}

export interface BilibiliClientOptions {
  cookie: BilibiliCookie;
  /**
   * 完整 Cookie 串（可选）：浏览器 DevTools 复制的全部 Cookie（含 buvid3/buvid4/b_lsid 等指纹）。
   * 提供后优先使用；否则回退到 cookie 三件套。
   */
  cookieString?: string;
  /**
   * Cookie 持久化文件（可选）：自动续期（bili_ticket 等）得到的新值写回该文件，
   * 启动时优先读取文件（文件优先于 env，保证续期结果跨重启保留）。
   */
  cookieFile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** wbi key 缓存有效期（毫秒），默认 1 小时。 */
  wbiCacheTtlMs?: number;
}

interface WbiKeys {
  imgKey: string;
  subKey: string;
}

interface BiliResponse {
  code: number;
  message: string;
  data?: unknown;
}

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const IMAGE_UPLOAD_URL = 'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs';
const DYNAMIC_CREATE_URL = 'https://api.bilibili.com/x/dynamic/feed/create/dyn';
const TICKET_URL = 'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket';
const COOKIE_INFO_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/info';
// GenWebTicket 的 hmac key（公开于 bilibili-API-collect）
const TICKET_HMAC_KEY = 'XgwSnGZ1p';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 业务 code 中表示登录失效 / 风控的常见值
// -101 账号未登录、-111 csrf 校验失败、-352 风控校验失败、-412 请求被拦截
const AUTH_CODES = new Set([-101, -111, -352, -412]);

/**
 * Bilibili 客户端（规格 §36 / §40）。
 * 封装 wbi 签名、Cookie 认证、统一错误处理。
 * 测试通过注入 fetchImpl 完全隔离真实网络。
 */
export class BilibiliClient {
  private readonly cookie: BilibiliCookie;
  private cookieString: string;
  private readonly cookieFile: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly wbiCacheTtlMs: number;
  private wbiCache: { keys: WbiKeys; expiresAt: number } | null = null;

  constructor(options: BilibiliClientOptions) {
    this.cookie = options.cookie;
    this.cookieFile = options.cookieFile ?? null;
    // 优先读取持久化文件（续期结果跨重启保留），否则用 env 初值
    const fromFile = this.#loadCookieFromFile();
    this.cookieString = fromFile ?? options.cookieString ?? '';
    if (this.cookieFile && !fromFile && this.cookieString.trim()) {
      this.#saveCookieFile();
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.wbiCacheTtlMs = options.wbiCacheTtlMs ?? 60 * 60 * 1000;
  }

  /** 是否已配置完整 Cookie（未配置时所有接口都会报登录失效）。 */
  hasCookie(): boolean {
    if (this.cookieString.trim()) {
      return true;
    }
    return Boolean(this.cookie.sessdata && this.cookie.jct && this.cookie.dedeuserid);
  }

  /**
   * 上传图片，返回 Bilibili 图片信息（用于动态 pics[]，规格 §35）。
   * 接口：POST /x/dynamic/feed/draw/upload_bfs（multipart file_up + category + csrf）。
   */
  async uploadImage(
    buffer: Buffer,
    filename: string,
  ): Promise<{ url: string; width: number; height: number; sizeKb: number }> {
    const form = new FormData();
    form.append('file_up', new Blob([new Uint8Array(buffer)]), filename);
    form.append('category', 'daily');
    form.append('biz', 'new_dyn');
    form.append('csrf', this.#jct());
    const payload = await this.#request(IMAGE_UPLOAD_URL, { method: 'POST', body: form });
    const data = payload.data as
      | { image_url?: string; image_width?: number; image_height?: number; img_size?: number }
      | undefined;
    const imageUrl = data?.image_url;
    if (!imageUrl) {
      throw new BilibiliApiError('图片上传成功但未返回图片地址', payload.code);
    }
    return {
      url: imageUrl,
      width: data?.image_width ?? 0,
      height: data?.image_height ?? 0,
      sizeKb: data?.img_size ?? 0,
    };
  }

  /**
   * 发布图片动态（type=4），返回动态 ID。
   * content 为最终翻译文本；pics 为已上传的 Bilibili 图片 URL；topicId 可选。
   */
  /**
   * 发布图片动态（新接口 POST /x/dynamic/feed/create/dyn，支持图片与话题）。
   * 文本在 dyn_req.content.contents[].raw_text；scene=2 带图。
   */
  async publishDynamic(input: {
    text: string;
    pics?: UploadedImage[];
    topicId?: string | null;
    topicName?: string | null;
  }): Promise<string> {
    const dynReq: Record<string, unknown> = {
      content: { contents: [{ raw_text: input.text, type: 1, biz_id: '' }] },
      scene: input.pics && input.pics.length > 0 ? 2 : 1,
      option: { close_comment: 0 },
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    };
    if (input.pics && input.pics.length > 0) {
      dynReq.pics = input.pics.map((p) => ({
        img_src: p.url,
        img_width: p.width,
        img_height: p.height,
        img_size: p.sizeKb,
      }));
    }
    if (input.topicId) {
      dynReq.topic = {
        from_source: 'dyn.web.list',
        from_topic_id: 0,
        id: Number(input.topicId),
        name: input.topicName ?? '',
      };
    }
    const wbi = await this.#signedParams({ csrf: this.#jct() });
    const url = `${DYNAMIC_CREATE_URL}?csrf=${this.#jct()}&w_rid=${wbi.w_rid}&wts=${wbi.wts}`;
    const payload = await this.#request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dyn_req: dynReq }),
    });
    const data = payload.data as { dyn_id_str?: string } | undefined;
    const dynamicId = data?.dyn_id_str;
    if (!dynamicId) {
      throw new BilibiliApiError('动态发布成功但未返回动态 ID', payload.code);
    }
    return String(dynamicId);
  }

  async #signedParams(params: Record<string, string | number>): Promise<WbiSignResult> {
    const keys = await this.#getWbiKeys();
    return signWbi(params, keys.imgKey, keys.subKey);
  }

  async #getWbiKeys(): Promise<WbiKeys> {
    const now = Date.now();
    if (this.wbiCache && this.wbiCache.expiresAt > now) {
      return this.wbiCache.keys;
    }
    const payload = await this.#request(NAV_URL, {});
    const wbiImg = (payload.data as { wbi_img?: { img_url?: string; sub_url?: string } } | undefined)
      ?.wbi_img;
    if (!wbiImg?.img_url || !wbiImg.sub_url) {
      throw new BilibiliAuthError('无法获取 wbi 签名密钥（可能未登录）', -101);
    }
    const keys: WbiKeys = {
      imgKey: extractKeyFromImageUrl(wbiImg.img_url),
      subKey: extractKeyFromImageUrl(wbiImg.sub_url),
    };
    this.wbiCache = { keys, expiresAt: now + this.wbiCacheTtlMs };
    return keys;
  }

  async #request(url: string, init: RequestInit): Promise<BiliResponse> {
    if (!this.hasCookie()) {
      throw new BilibiliAuthError('未配置 Bilibili Cookie（BILI_SESSDATA/BILI_JCT/BILI_DEDEUSERID）');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          cookie: this.#cookieHeader(),
          // 以下头尽可能贴近真实浏览器（Chrome/Windows，t.bilibili.com 动态编辑器），
          // 与 wbi 签名配合降低风控误判
          'user-agent': BROWSER_UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
          origin: 'https://t.bilibili.com',
          referer: 'https://t.bilibili.com/',
          ...init.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new BilibiliNetworkError(
        timedOut ? `Bilibili 请求超时: ${url}` : `无法连接 Bilibili: ${String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 412) {
      throw new BilibiliAuthError(`Bilibili 登录失效（HTTP ${response.status}）`, response.status);
    }
    if (!response.ok) {
      throw new BilibiliNetworkError(`Bilibili HTTP ${response.status}`);
    }

    let payload: BiliResponse;
    try {
      payload = (await response.json()) as BiliResponse;
    } catch {
      throw new BilibiliNetworkError('Bilibili 返回了无效 JSON');
    }

    if (payload.code !== 0) {
      const message = payload.message || `Bilibili 错误 code=${payload.code}`;
      if (AUTH_CODES.has(payload.code)) {
        throw new BilibiliAuthError(`Bilibili 登录失效: ${message}`, payload.code);
      }
      throw new BilibiliApiError(message, payload.code);
    }
    return payload;
  }

  /** csrf token：优先 cookie.jct，否则从完整 Cookie 串解析 bili_jct=。 */
  #jct(): string {
    if (this.cookie.jct) {
      return this.cookie.jct;
    }
    const match = /(?:^|;\s*)bili_jct=([^;]+)/.exec(this.cookieString);
    return match?.[1] ?? '';
  }

  #cookieHeader(): string {
    if (this.cookieString.trim()) {
      return this.cookieString.trim();
    }
    return [
      `SESSDATA=${this.cookie.sessdata}`,
      `bili_jct=${this.cookie.jct}`,
      `DedeUserID=${this.cookie.dedeuserid}`,
    ].join('; ');
  }

  // ---------- 会话体检 / bili_ticket 自动续期 ----------

  /**
   * 检查当前会话：是否登录、B 站是否提示需要刷新（SESSDATA 临近过期）。
   * 纯查询接口，不产生任何内容。
   */
  async checkSession(): Promise<{ loggedIn: boolean; uname: string | null; refreshNeeded: boolean }> {
    let loggedIn = false;
    let uname: string | null = null;
    try {
      const navPayload = await this.#request(NAV_URL, {});
      const navData = navPayload.data as { isLogin?: boolean; uname?: string } | undefined;
      loggedIn = navData?.isLogin === true;
      uname = navData?.uname ?? null;
    } catch (error) {
      if (error instanceof BilibiliAuthError) {
        return { loggedIn: false, uname: null, refreshNeeded: false };
      }
      throw error;
    }
    let refreshNeeded = false;
    try {
      const payload = await this.#request(
        `${COOKIE_INFO_URL}?csrf=${encodeURIComponent(this.#jct())}`,
        {},
      );
      refreshNeeded = (payload.data as { refresh?: boolean } | undefined)?.refresh === true;
    } catch {
      // cookie/info 失败（如被风控）不影响主结论
    }
    return { loggedIn, uname, refreshNeeded };
  }

  /**
   * 刷新 bili_ticket（官方 GenWebTicket，浏览器同款），并把新值写回 cookie。
   * 返回新 ticket 与过期时间（秒）；失败返回 null（保持旧值）。
   */
  async refreshTicket(): Promise<{ ticket: string; expiresAt: number } | null> {
    const ts = Math.floor(Date.now() / 1000);
    const hexsign = createHmac('sha256', TICKET_HMAC_KEY).update(`ts${ts}`).digest('hex');
    const params = new URLSearchParams({
      key_id: 'ec02',
      hexsign,
      'context[ts]': String(ts),
      csrf: this.#jct(),
    });
    const payload = await this.#request(`${TICKET_URL}?${params.toString()}`, { method: 'POST' });
    const data = payload.data as { ticket?: string; created_at?: number; ttl?: number } | undefined;
    if (!data?.ticket) {
      return null;
    }
    const expiresAt = (data.created_at ?? ts) + (data.ttl ?? 0);
    this.#setCookiePair('bili_ticket', data.ticket);
    this.#setCookiePair('bili_ticket_expires', String(expiresAt));
    return { ticket: data.ticket, expiresAt };
  }

  /** 替换（或追加）cookie 串中的某个 name=value 并持久化。 */
  #setCookiePair(name: string, value: string): void {
    const pattern = new RegExp(`(?:^|;\\s*)${name}=[^;]*`);
    if (pattern.test(this.cookieString)) {
      this.cookieString = this.cookieString.replace(pattern, `${name}=${value}`);
    } else {
      const base = this.cookieString.trim();
      this.cookieString = base.length > 0 ? `${base}; ${name}=${value}` : `${name}=${value}`;
    }
    this.#saveCookieFile();
  }

  #loadCookieFromFile(): string | null {
    if (!this.cookieFile) return null;
    try {
      if (!fs.existsSync(this.cookieFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8')) as {
        cookieString?: string;
      };
      const value = parsed.cookieString?.trim();
      if (value && /SESSDATA=/.test(value) && /bili_jct=/.test(value)) {
        return value;
      }
      return null;
    } catch {
      return null;
    }
  }

  #saveCookieFile(): void {
    if (!this.cookieFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      fs.writeFileSync(
        this.cookieFile,
        JSON.stringify(
          { cookieString: this.cookieString, updatedAt: new Date().toISOString() },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error('[bilibili] cookie 文件写入失败:', error);
    }
  }
}
