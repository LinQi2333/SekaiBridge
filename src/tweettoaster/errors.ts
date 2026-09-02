/**
 * TweetToaster 客户端错误。
 * TweetNotFoundError 是来源删除（SOURCE_DELETED）检测的明确信号：
 * 只有 Provider 明确返回 404 / tombstone / not found 才算删除。
 */
export class TweetToasterError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'TweetToasterError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/** 推文明确不存在（HTTP 404 / TWEET_NOT_FOUND / TIMELINE_NOT_FOUND）。 */
export class TweetNotFoundError extends TweetToasterError {
  constructor(message: string, options: { code?: string } = {}) {
    super(message, { status: 404, code: options.code ?? 'TWEET_NOT_FOUND' });
    this.name = 'TweetNotFoundError';
  }
}

/** TweetToaster 服务不可用（连接失败 / 超时 / 5xx）。 */
export class TweetToasterUnavailableError extends TweetToasterError {
  constructor(message: string) {
    super(message, { status: 503 });
    this.name = 'TweetToasterUnavailableError';
  }
}
