import { BilibiliApiError, BilibiliAuthError, BilibiliNetworkError } from './errors.js';
import { extractKeyFromImageUrl, signWbi, type WbiSignResult } from './wbi.js';

/** Bilibili 登录 Cookie（规格 §40：只放 .env，禁止进入 Git/日志）。 */
export interface BilibiliCookie {
  sessdata: string;
  jct: string;
  dedeuserid: string;
}

export interface BilibiliClientOptions {
  cookie: BilibiliCookie;
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
const DYNAMIC_CREATE_URL = 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create';

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
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly wbiCacheTtlMs: number;
  private wbiCache: { keys: WbiKeys; expiresAt: number } | null = null;

  constructor(options: BilibiliClientOptions) {
    this.cookie = options.cookie;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.wbiCacheTtlMs = options.wbiCacheTtlMs ?? 60 * 60 * 1000;
  }

  /** 是否已配置完整 Cookie（未配置时所有接口都会报登录失效）。 */
  hasCookie(): boolean {
    return Boolean(this.cookie.sessdata && this.cookie.jct && this.cookie.dedeuserid);
  }

  /**
   * 上传图片，返回 Bilibili 图片 URL（用于动态 pics[]，规格 §35）。
   * 接口：POST /x/dynamic/feed/draw/upload_bfs（multipart file_up + category + csrf）。
   */
  async uploadImage(buffer: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file_up', new Blob([new Uint8Array(buffer)]), filename);
    form.append('category', 'daily');
    form.append('biz', 'new_dyn');
    form.append('csrf', this.cookie.jct);
    const payload = await this.#request(IMAGE_UPLOAD_URL, { method: 'POST', body: form });
    const data = payload.data as { image_url?: string } | undefined;
    const imageUrl = data?.image_url;
    if (!imageUrl) {
      throw new BilibiliApiError('图片上传成功但未返回图片地址', payload.code);
    }
    return imageUrl;
  }

  /**
   * 发布图片动态（type=4），返回动态 ID。
   * content 为最终翻译文本；pics 为已上传的 Bilibili 图片 URL；topicId 可选。
   */
  async publishDynamic(input: {
    text: string;
    pics?: string[];
    topicId?: string | null;
  }): Promise<string> {
    const params: Record<string, string | number> = {
      type: 4,
      biz_id: JSON.stringify(input.pics ?? []),
      content: input.text,
    };
    if (input.topicId) {
      params.topic_id = input.topicId;
    }
    const wbi = await this.#signedParams(params);
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...params, ...wbi, csrf: this.cookie.jct })) {
      form.append(key, String(value));
    }
    const payload = await this.#request(DYNAMIC_CREATE_URL, { method: 'POST', body: form });
    const data = payload.data as { dynamic_id?: string | number } | undefined;
    const dynamicId = data?.dynamic_id;
    if (dynamicId === undefined || dynamicId === null) {
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
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

  #cookieHeader(): string {
    return [
      `SESSDATA=${this.cookie.sessdata}`,
      `bili_jct=${this.cookie.jct}`,
      `DedeUserID=${this.cookie.dedeuserid}`,
    ].join('; ');
  }
}
