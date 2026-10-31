import { MediaDownloadError } from './media-download-error.js';

/** 允许的图片 Content-Type 白名单（规格 §48 图片格式白名单）。 */
export const IMAGE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

/** Content-Type → 文件扩展名。 */
export const EXT_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export interface SafeDownloadOptions {
  /** 等待响应头（连接 + 首字节）的超时（毫秒），默认 15000。 */
  timeoutMs?: number;
  /**
   * 正文"空闲"超时（毫秒）：相邻两块数据的最大间隔，默认等于 timeoutMs。
   * 只要数据还在流动就不会中断 —— 大文件在慢带宽下不会被整体超时掐断。
   */
  idleTimeoutMs?: number;
  /** 最大字节数，默认 20MB。 */
  maxBytes?: number;
  /** 超限提示里的名称，默认「文件大小限制」。 */
  maxBytesLabel?: string;
  /** Content-Type 白名单，默认 IMAGE_CONTENT_TYPES。 */
  allowedContentTypes?: readonly string[];
  fetchImpl?: typeof fetch;
  /** 进度回调（每收到一块数据调用一次）。 */
  onProgress?: (progress: { received: number; total: number | null }) => void;
}

export interface SafeDownloadResult {
  bytes: Buffer;
  /** 归一化的 Content-Type（已去掉 charset 等参数）。 */
  contentType: string;
  url: string;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 安全远程下载（规格 §48）：
 * - 只允许 HTTP / HTTPS（禁止 file:// 与任意本地路径）；
 * - 响应头超时 + 正文**空闲**超时（慢速下载不会被整体超时掐断，卡死才会中断）；
 * - 最大文件大小（Content-Length 预检 + 实际字节数校验）；
 * - 校验 Content-Type 属于白名单；
 * - 只返回字节内容，绝不执行媒体。
 */
export async function safeDownload(
  url: string,
  options: SafeDownloadOptions = {},
): Promise<SafeDownloadResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const label = options.maxBytesLabel ?? '文件大小限制';
  const allowed = options.allowedContentTypes ?? IMAGE_CONTENT_TYPES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaDownloadError('BAD_PROTOCOL', `无效的 URL: ${truncate(url, 200)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MediaDownloadError('BAD_PROTOCOL', `只允许 HTTP/HTTPS 下载，收到: ${parsed.protocol}`);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** 内部：超时信号（用于把"无响应/空闲"与网络错误区分开）。 */
  class Timeout extends Error {
    constructor(readonly phase: 'response' | 'body') {
      super(`timeout during ${phase}`);
      this.name = 'MediaTimeout';
    }
  }

  /** 在 ms 内没完成就中断请求并抛出 Timeout（不依赖注入的 fetch 是否支持取消）。 */
  const withTimeout = async <T>(run: () => Promise<T>, ms: number, phase: 'response' | 'body'): Promise<T> => {
    let rejectTimeout: ((error: unknown) => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
      timer = setTimeout(() => {
        controller.abort(new DOMException('Request timed out', 'AbortError'));
        reject(new Timeout(phase));
      }, ms);
    });
    const pending = run();
    // 超时后 pending 的拒绝不应变成 unhandledRejection
    void pending.catch(() => {});
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
      timer = undefined;
      void rejectTimeout;
    }
  };

  let received = 0;
  let total: number | null = null;
  try {
    const response = await withTimeout(
      () => fetchImpl(url, { signal: controller.signal }),
      timeoutMs,
      'response',
    );
    if (!response.ok) {
      throw new MediaDownloadError(
        'HTTP_ERROR',
        `下载返回 HTTP ${response.status}: ${truncate(url, 200)}`,
        response.status,
      );
    }
    const contentType = normalizeContentType(response.headers.get('content-type'));
    if (!allowed.includes(contentType)) {
      throw new MediaDownloadError('BAD_CONTENT_TYPE', `Content-Type 不在白名单: ${contentType || '(空)'}`);
    }
    const tooLarge = (): MediaDownloadError =>
      new MediaDownloadError(
        'TOO_LARGE',
        `超过${label} ${megabytes(maxBytes)}: ${truncate(url, 200)}`,
      );
    const declared = Number(response.headers.get('content-length'));
    total = Number.isFinite(declared) && declared > 0 ? declared : null;
    if (total !== null && total > maxBytes) {
      throw tooLarge();
    }

    const chunks: Buffer[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await withTimeout(() => reader.read(), idleTimeoutMs, 'body');
          if (done) {
            break;
          }
          received += value.byteLength;
          if (received > maxBytes) {
            void reader.cancel().catch(() => {});
            throw tooLarge();
          }
          chunks.push(Buffer.from(value));
          options.onProgress?.({ received, total });
        }
      } finally {
        reader.releaseLock();
      }
    }
    return { bytes: Buffer.concat(chunks, received), contentType, url };
  } catch (error) {
    if (error instanceof MediaDownloadError) {
      throw error;
    }
    const timeoutPhase =
      error instanceof Timeout ? error.phase : error instanceof Error && error.name === 'AbortError' ? 'response' : null;
    if (timeoutPhase !== null) {
      const phase =
        timeoutPhase === 'body'
          ? `空闲 ${duration(idleTimeoutMs)} 无数据`
          : `${duration(timeoutMs)} 内无响应`;
      throw new MediaDownloadError(
        'TIMEOUT',
        `下载超时（${phase}，已收 ${megabytes(received)}${total !== null ? `/${megabytes(total)}` : ''}）: ${truncate(url, 200)}`,
      );
    }
    const cause = (error as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === 'string' ? `（${cause.code}）` : '';
    throw new MediaDownloadError('FETCH_FAILED', `下载失败${code}: ${truncate(url, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeContentType(value: string | null): string {
  if (!value) return '';
  const main = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return main === 'image/jpg' ? 'image/jpeg' : main;
}

/** 字节数 → 人类可读（用于日志与错误提示）。 */
export function megabytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}

/** 毫秒 → 人类可读时长（用于超时提示）。 */
function duration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
