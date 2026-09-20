import fs from 'node:fs';
import path from 'node:path';
import { constants, createHmac, createPublicKey, publicEncrypt, randomUUID } from 'node:crypto';
import { consumeResponse } from '../http/response.js';
import { BilibiliApiError, BilibiliAuthError, BilibiliNetworkError } from './errors.js';
import type { UploadedImage } from './image-upload.js';
import { extractKeyFromImageUrl, signWbi, type WbiSignResult } from './wbi.js';

/**
 * Bilibili 客户端配置。
 * 凭据**唯一来源**是 cookie 文件（由扫码登录工具写入），不再支持环境变量手工填 Cookie。
 */
export interface BilibiliClientOptions {
  /** 凭据文件路径（固定为数据目录下的 bili-cookies.json）。 */
  cookieFile: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** wbi key 缓存有效期（毫秒），默认 1 小时。 */
  wbiCacheTtlMs?: number;
}

interface WbiKeys {
  imgKey: string;
  subKey: string;
}

/** SESSDATA 自动续期结果。 */
export interface CookieRefreshResult {
  refreshed: boolean;
  /** 未续期时的原因（供日志/告警）。 */
  reason?: string;
  /** 新 SESSDATA 的过期时间（毫秒；来自 set-cookie Expires，取不到为 null）。 */
  sessdataExpiresAt?: number | null;
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
const COOKIE_REFRESH_CSRF_URL =
  'https://passport.bilibili.com/x/passport-login/web/cookie/refresh/csrf';
const COOKIE_REFRESH_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh';
const COOKIE_CONFIRM_REFRESH_URL =
  'https://passport.bilibili.com/x/passport-login/web/confirm/refresh';
const CORRESPOND_URL = 'https://www.bilibili.com/correspond/1/';
// GenWebTicket 的 hmac key（公开于 bilibili-API-collect）
const TICKET_HMAC_KEY = 'XgwSnGZ1p';
// CorrespondPath 用的 RSA 公钥（公开于 bilibili-API-collect，Web 首页 wasm 逆向）
const CORRESPOND_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

/** 刷新成功后 B 站会重设的 Cookie 项。 */
const REFRESHED_COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 业务 code 中表示登录失效 / 风控的常见值
// -101 账号未登录、-111 csrf 校验失败、-352 风控校验失败、-412 请求被拦截
const AUTH_CODES = new Set([-101, -111, -352, -412]);

/** refresh_token 与 cookie 不匹配 / refresh_csrf 错误（86095）。 */
const REFRESH_TOKEN_MISMATCH_CODE = 86095;

/**
 * 生成 CorrespondPath：RSA-OAEP(SHA-256) 加密 `refresh_<毫秒时间戳>`，输出小写 base16。
 * 算法来源：B 站 Web 首页 wasm（bilibili-API-collect 文档）。
 */
export function correspondPath(timestampMs: number): string {
  const encrypted = publicEncrypt(
    {
      key: createPublicKey(CORRESPOND_PUBLIC_KEY),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(`refresh_${timestampMs}`, 'utf8'),
  );
  return encrypted.toString('hex');
}

/** 从 correspond 页面 HTML 提取 refresh_csrf（`<div id="1-name">xxx</div>`）。 */
export function extractRefreshCsrf(html: string): string | null {
  const match = /id=["']1-name["'][^>]*>([^<]+)</.exec(html);
  return match?.[1]?.trim() || null;
}

/** 解析 set-cookie 头：返回 name=value 映射（同名取最后一个）。 */
export function parseSetCookies(headers: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of headers) {
    const pair = header.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return cookies;
}

/** 取 set-cookie 中某项的 Expires 时间（毫秒）；无则返回 null。 */
export function setCookieExpiry(header: string): number | null {
  const match = /;\s*expires=([^;]+)/i.exec(header);
  if (!match?.[1]) return null;
  const parsed = Date.parse(match[1].trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** 从 Cookie 串里取某个字段（浏览器 Cookie 或 localStorage 导出的 ac_time_value）。 */
export function cookieValue(cookieString: string, name: string): string | null {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieString);
  return match?.[1]?.trim() || null;
}

/**
 * 在 Cookie 串上批量替换/追加 name=value，返回**新串**（不改原串）。
 * 按字段解析、序列化，保留分隔符；避免值里出现 `$&`/`$'` 这类字符被当成替换模式。
 */
export function withCookiePairs(
  base: string,
  cookies: Record<string, string>,
  names: string[],
): string {
  const pairs = new Map<string, string>();
  for (const part of base.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) pairs.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  for (const name of names) {
    const value = cookies[name];
    if (value) pairs.set(name, value);
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** 日志用：打印 B 站响应，敏感字段（token/cookie 类）只留长度。 */
export function redactPayload(payload: unknown): string {
  if (payload === undefined || payload === null) {
    return '';
  }
  const sensitive = /(refresh_token|sessdata|bili_jct|cookie|ticket|token)/i;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = sensitive.test(key) ? `<redacted len=${String(item ?? '').length}>` : walk(item);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(walk(payload));
}

/**
 * Bilibili 客户端（规格 §36 / §40）。
 * 封装 wbi 签名、Cookie 认证、统一错误处理。
 * 测试通过注入 fetchImpl 完全隔离真实网络。
 */
export class BilibiliClient {
  private cookieString: string;
  private readonly cookieFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly wbiCacheTtlMs: number;
  private wbiCache: { keys: WbiKeys; expiresAt: number } | null = null;
  /** 当前生效的持久化刷新口令（ac_time_value），来自凭据文件。 */
  private refreshToken: string | null;
  private pendingRefreshTokens: string[] = [];
  private refreshInFlight: Promise<CookieRefreshResult> | null = null;

  constructor(options: BilibiliClientOptions) {
    this.cookieFile = options.cookieFile;
    // 凭据全部来自文件（扫码登录工具写入，续期时回写）
    const fromFile = this.#loadCookieFromFile();
    this.cookieString = fromFile?.cookieString ?? '';
    this.refreshToken =
      fromFile?.refreshToken ??
      (this.cookieString ? cookieValue(this.cookieString, 'ac_time_value') : null);
    this.pendingRefreshTokens = fromFile?.pendingRefreshTokens ?? [];
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.wbiCacheTtlMs = options.wbiCacheTtlMs ?? 60 * 60 * 1000;
  }

  /** 是否已登录（凭据文件存在且有内容；未配置时所有接口都会报登录失效）。 */
  hasCookie(): boolean {
    return this.cookieString.trim().length > 0;
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
      // create/dyn 校验图片地址协议，统一转 https（B 站可能返回 http://）
      url: imageUrl.replace(/^http:\/\//i, 'https://'),
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
      // name 只在提供真实话题名时才发送：B 站会校验 name 与 topic_id 匹配，
      // 别名/空名会导致 4126130"请求数据发生错误"
      dynReq.topic = {
        from_source: 'dyn.web.list',
        from_topic_id: 0,
        id: Number(input.topicId),
        ...(input.topicName ? { name: input.topicName } : {}),
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
    return this.#fetchRaw(url, init, async (response) => {
      if (response.status === 401 || response.status === 412) {
        throw new BilibiliAuthError(`Bilibili 登录失效（HTTP ${response.status}）`, response.status);
      }
      if (!response.ok) {
        throw new BilibiliNetworkError(`Bilibili HTTP ${response.status}`);
      }

      let payload: BiliResponse;
      try {
        payload = (await response.json()) as BiliResponse;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BilibiliNetworkError('Bilibili 返回了无效 JSON');
      }

      if (payload.code !== 0) {
        const message = payload.message || `Bilibili 错误 code=${payload.code}`;
        if (AUTH_CODES.has(payload.code)) {
          throw new BilibiliAuthError(`Bilibili 登录失效: ${message}`, payload.code);
        }
        // 错误信息带 code，便于定位（如 -352 风控 / -400 参数）
        throw new BilibiliApiError(`${message}（code=${payload.code}）`, payload.code);
      }
      return payload;
    });
  }

  /** 底层请求：统一带 Cookie 与浏览器风格头，网络异常转 BilibiliNetworkError。 */
  async #fetchRaw<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    if (!this.hasCookie()) {
      throw new BilibiliAuthError(
        '未配置 Bilibili 凭据：请先运行扫码登录工具（docker compose stop app && docker compose --profile tools run --rm bili-login && docker compose up -d app）',
      );
    }
    try {
      return await consumeResponse(this.fetchImpl, url, {
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
      }, this.timeoutMs, consume);
    } catch (error) {
      if (error instanceof BilibiliApiError || error instanceof BilibiliAuthError || error instanceof BilibiliNetworkError) {
        throw error;
      }
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new BilibiliNetworkError(
        timedOut ? `Bilibili 请求超时: ${url}` : `无法连接 Bilibili: ${String(error)}`,
      );
    }
  }

  /**
   * 宽松请求：网络/业务错误都不抛异常，返回结果对象（供自动续期流程使用，
   * 失败时只降级为日志，不影响主业务）。失败时一并带回原始 payload，便于定位 -400 之类。
   */
  async #softJson(
    url: string,
    init: RequestInit = {},
  ): Promise<
    | { ok: true; payload: BiliResponse; response: Response }
    | { ok: false; error: string; code?: number; payload?: unknown; status?: number }
  > {
    try {
      return await this.#fetchRaw(url, init, async (response) => {
        let payload: BiliResponse;
        try {
          payload = (await response.json()) as BiliResponse;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return { ok: false as const, error: response.ok ? '返回了无效 JSON' : `HTTP ${response.status}` };
        }
        if (!response.ok) {
          return { ok: false as const, error: `HTTP ${response.status}`, status: response.status, payload };
        }
        if (payload.code !== 0) {
          return { ok: false as const, error: payload.message || `code=${payload.code}`, code: payload.code, payload };
        }
        return { ok: true as const, payload, response };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** csrf token：取凭据串里的 `bili_jct`（与 Cookie 头同源）。 */
  #jct(): string {
    return (this.cookieString ? cookieValue(this.cookieString, 'bili_jct') : null) ?? '';
  }

  #cookieHeader(): string {
    return this.cookieString.trim();
  }

  // ---------- 会话体检 / bili_ticket 自动续期 ----------

  /**
   * 检查当前会话：是否登录、B 站是否提示需要刷新（SESSDATA 临近过期）。
   * 同时重试已经落盘的续期确认；不创建动态等内容。
   */
  async checkSession(): Promise<{ loggedIn: boolean; uname: string | null; refreshNeeded: boolean }> {
    await this.#confirmPendingRefresh();
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
   * 返回新 ticket 与过期时间（秒）；响应缺少 ticket 时返回 null，网络或落盘失败抛错。
   */
  async refreshTicket(): Promise<{ ticket: string; expiresAt: number } | null> {
    if (this.refreshInFlight) await this.refreshInFlight;
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
    const candidate = withCookiePairs(this.cookieString, {
      bili_ticket: data.ticket, bili_ticket_expires: String(expiresAt),
    }, ['bili_ticket', 'bili_ticket_expires']);
    this.#saveCookieFile(candidate);
    this.cookieString = candidate;
    return { ticket: data.ticket, expiresAt };
  }

  // ---------- SESSDATA 自动续期（Web 端 Cookie 刷新机制） ----------

  /** 当前是否具备自动续期条件（有 refresh_token / ac_time_value）。 */
  canRefreshCookie(): boolean {
    return Boolean(this.refreshToken);
  }

  /** 刷新调用合并；新凭据自检、原子落盘成功后才确认旧凭据失效。 */
  refreshLoginCookie(): Promise<CookieRefreshResult> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.#refreshLoginCookie().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  async #refreshLoginCookie(): Promise<CookieRefreshResult> {
    if (!this.hasCookie()) return { refreshed: false, reason: '未配置 Cookie' };
    await this.#confirmPendingRefresh();
    const oldToken = this.refreshToken;
    if (!oldToken) return { refreshed: false, reason: '缺少 refresh_token（ac_time_value），无法自动续期' };

    // 86095 也可能仅为实时 CSRF 失效：重新取时间戳和 CSRF，最多重试一次。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const info = await this.#softJson(`${COOKIE_INFO_URL}?csrf=${encodeURIComponent(this.#jct())}`);
      if (!info.ok) return { refreshed: false, reason: `cookie/info 失败: ${info.error}` };
      const data = info.payload.data as { refresh?: boolean; timestamp?: number } | undefined;
      if (data?.refresh !== true) return { refreshed: false, reason: 'B站未提示需要刷新' };
      const correspond = correspondPath(data.timestamp ?? Date.now());
      const csrf = (await this.#refreshCsrfByApi(correspond)) ?? (await this.#refreshCsrfByPage(correspond));
      if (!csrf) return { refreshed: false, reason: '获取 refresh_csrf 失败' };
      const refreshed = await this.#softJson(COOKIE_REFRESH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://www.bilibili.com', referer: 'https://www.bilibili.com/',
        },
        body: new URLSearchParams({ csrf: this.#jct(), refresh_csrf: csrf,
          source: 'main_web', refresh_token: oldToken }).toString(),
      });
      if (!refreshed.ok) {
        if (refreshed.code === REFRESH_TOKEN_MISMATCH_CODE && attempt === 0) continue;
        console.error(`[bilibili] cookie/refresh 失败: ${refreshed.error} ${redactPayload(refreshed.payload)}`);
        return { refreshed: false, reason: `cookie/refresh 失败: ${refreshed.error}（code=${refreshed.code ?? 'unknown'}），已保留刷新口令` };
      }
      const headers = refreshed.response.headers.getSetCookie();
      const cookies = parseSetCookies(headers);
      const result = refreshed.payload.data as { refresh_token?: string; url?: string } | undefined;
      const newToken = result?.refresh_token;
      if (!cookies.SESSDATA || !cookies.bili_jct || !newToken) {
        return { refreshed: false, reason: '刷新响应缺少 SESSDATA、bili_jct 或 refresh_token，已保留旧凭据' };
      }
      const candidate = withCookiePairs(this.cookieString, cookies, REFRESHED_COOKIE_NAMES);
      // 验证候选 Cookie 时不修改共享状态，避免并发业务请求读到未经验证的凭据。
      const check = await this.#softJson(NAV_URL, { headers: { cookie: candidate } });
      if (!check.ok || (check.payload.data as { isLogin?: boolean } | undefined)?.isLogin !== true) {
        console.error('[bilibili] 新 Cookie 自检未通过，已保留旧 Cookie');
        return { refreshed: false, reason: '新 Cookie 自检未通过，已保留旧 Cookie' };
      }
      const pending = [...new Set([...this.pendingRefreshTokens, oldToken])];
      try {
        this.#saveCookieFile(candidate, newToken, pending);
      } catch {
        return { refreshed: false, reason: '新凭据写入失败，未确认旧凭据失效；已保留旧 Cookie' };
      }
      this.cookieString = candidate;
      this.refreshToken = newToken;
      this.pendingRefreshTokens = pending;
      await this.#confirmPendingRefresh();
      if (result?.url) {
        const sso = await this.#softJson(result.url);
        if (!sso.ok) console.error(`[bilibili] SSO 跨域登录失败（继续）: ${sso.error}`);
      }
      const sessdataHeader = headers.find((header) => /^SESSDATA=/i.test(header.trim()));
      return { refreshed: true, sessdataExpiresAt: sessdataHeader ? setCookieExpiry(sessdataHeader) : null };
    }
    return { refreshed: false, reason: '刷新失败，已保留刷新口令' };
  }

  /** 待确认口令随新凭据落盘；重启后可补确认，失败不阻塞新会话使用。 */
  async #confirmPendingRefresh(): Promise<void> {
    for (const token of [...this.pendingRefreshTokens]) {
      const confirm = await this.#softJson(COOKIE_CONFIRM_REFRESH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://www.bilibili.com', referer: 'https://www.bilibili.com/',
        },
        body: new URLSearchParams({ csrf: this.#jct(), refresh_token: token }).toString(),
      });
      if (!confirm.ok) {
        console.error(`[bilibili] confirm/refresh 失败（新凭据已保存，下次重试）: ${confirm.error}（code=${confirm.code ?? 'unknown'}） ${redactPayload(confirm.payload)}`);
        continue;
      }
      const pending = this.pendingRefreshTokens.filter((item) => item !== token);
      try {
        this.#saveCookieFile(this.cookieString, this.refreshToken, pending);
        this.pendingRefreshTokens = pending;
      } catch {
        // 新凭据此前已可靠保存；这里只是清理待确认标记失败。
      }
    }
  }

  /** 优先走 JSON 版 refresh_csrf 接口（存在时比抓 HTML 稳）。 */
  async #refreshCsrfByApi(correspond: string): Promise<string | null> {
    const result = await this.#softJson(
      `${COOKIE_REFRESH_CSRF_URL}?csrf=${encodeURIComponent(this.#jct())}&refresh_csrf=${encodeURIComponent(correspond)}`,
      {
        headers: {
          origin: 'https://www.bilibili.com',
          referer: 'https://www.bilibili.com/',
        },
      },
    );
    if (!result.ok) {
      return null;
    }
    return (result.payload.data as { refresh_csrf?: string } | undefined)?.refresh_csrf ?? null;
  }

  /** 兜底：抓 correspond 页面 HTML 里的 `1-name` 节点。 */
  async #refreshCsrfByPage(correspond: string): Promise<string | null> {
    try {
      return await this.#fetchRaw(`${CORRESPOND_URL}${correspond}`, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'same-site', origin: 'https://www.bilibili.com',
          referer: 'https://www.bilibili.com/',
        },
      }, async (response) => response.ok ? extractRefreshCsrf(await response.text()) : null);
    } catch {
      return null;
    }
  }

  #loadCookieFromFile(): { cookieString: string; refreshToken: string | null; pendingRefreshTokens: string[] } | null {
    try {
      if (!fs.existsSync(this.cookieFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8')) as {
        cookieString?: string;
        refreshToken?: string;
        pendingRefreshTokens?: unknown;
      };
      const value = parsed.cookieString?.trim();
      if (!value || !/SESSDATA=/.test(value) || !/bili_jct=/.test(value)) {
        return null;
      }
      return {
        cookieString: value, refreshToken: parsed.refreshToken?.trim() || null,
        pendingRefreshTokens: Array.isArray(parsed.pendingRefreshTokens)
          ? parsed.pendingRefreshTokens.filter((item): item is string => typeof item === 'string' && item.length > 0) : [],
      };
    } catch {
      return null;
    }
  }

  #saveCookieFile(
    cookieString = this.cookieString,
    refreshToken = this.refreshToken,
    pendingRefreshTokens = this.pendingRefreshTokens,
  ): void {
    const temporary = `${this.cookieFile}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ cookieString, refreshToken, pendingRefreshTokens,
        updatedAt: new Date().toISOString() }, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.cookieFile);
      // Linux/Docker 上同步目录，确保原子替换也能跨崩溃保留。
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(this.cookieFile), 'r');
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
      }
    } catch (error) {
      console.error('[bilibili] cookie 文件写入失败:', error);
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
