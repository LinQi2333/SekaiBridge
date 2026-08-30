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
  /** 请求超时（毫秒），默认 15000。 */
  timeoutMs?: number;
  /** 最大字节数，默认 20MB。 */
  maxBytes?: number;
  /** Content-Type 白名单，默认 IMAGE_CONTENT_TYPES。 */
  allowedContentTypes?: readonly string[];
  fetchImpl?: typeof fetch;
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
 * - 请求超时；
 * - 最大文件大小（Content-Length 预检 + 实际字节数校验）；
 * - 校验 Content-Type 属于图片格式白名单；
 * - 只返回字节内容，绝不执行媒体。
 */
export async function safeDownload(
  url: string,
  options: SafeDownloadOptions = {},
): Promise<SafeDownloadResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    throw new MediaDownloadError(
      timedOut ? 'TIMEOUT' : 'FETCH_FAILED',
      timedOut ? `下载超时（${timeoutMs}ms）: ${truncate(url, 200)}` : `下载失败: ${truncate(url, 200)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new MediaDownloadError('HTTP_ERROR', `下载返回 HTTP ${response.status}: ${truncate(url, 200)}`, response.status);
  }

  const contentType = normalizeContentType(response.headers.get('content-type'));
  if (!allowed.includes(contentType)) {
    throw new MediaDownloadError(
      'BAD_CONTENT_TYPE',
      `Content-Type 不在白名单: ${contentType || '(空)'}（${truncate(url, 200)}）`,
    );
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new MediaDownloadError('TOO_LARGE', `文件超过大小限制 ${maxBytes} 字节: ${truncate(url, 200)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new MediaDownloadError('TOO_LARGE', `文件超过大小限制 ${maxBytes} 字节: ${truncate(url, 200)}`);
  }

  return { bytes: buffer, contentType, url };
}

export function normalizeContentType(value: string | null): string {
  if (!value) return '';
  const main = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return main === 'image/jpg' ? 'image/jpeg' : main;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
