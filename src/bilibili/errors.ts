/** Bilibili 客户端错误。 */

/** 登录失效 / 未登录 / 风控（规格 §40 / §54-18 Cookie 过期）。 */
export class BilibiliAuthError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = 'BilibiliAuthError';
    this.code = code;
  }
}

/** Bilibili 业务接口错误（code != 0）。 */
export class BilibiliApiError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'BilibiliApiError';
    this.code = code;
  }
}

/** 网络 / 超时等传输层错误。 */
export class BilibiliNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BilibiliNetworkError';
  }
}
