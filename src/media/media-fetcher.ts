import { safeDownload, type SafeDownloadOptions } from './safe-download.js';

/** 媒体获取函数：URL → 字节 + Content-Type。 */
export type MediaFetcher = (url: string) => Promise<{ bytes: Buffer; contentType: string }>;

/** Twitter 媒体 CDN 域名（走 TweetToaster /api/media 代理下载）。 */
export function isTwitterMediaUrl(url: string): boolean {
  try {
    return /\.twimg\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface MediaProxy {
  downloadMedia(url: string): Promise<{ bytes: Buffer; contentType: string }>;
}

/**
 * 构造媒体获取策略：
 * - Twitter 媒体（*.twimg.com）：优先走 TweetToaster /api/media 代理
 *   （主程序部署环境可能无法直连 Twitter CDN，而 TweetToaster 可以）；
 * - 其余（Bilibili 图床等）：直连 safeDownload（HTTP/HTTPS + 白名单安全约束）。
 */
export function createMediaFetcher(
  tweetToaster: MediaProxy | undefined,
  options: SafeDownloadOptions = {},
): MediaFetcher {
  return async (url: string) => {
    if (isTwitterMediaUrl(url) && typeof tweetToaster?.downloadMedia === 'function') {
      return tweetToaster.downloadMedia(url);
    }
    const result = await safeDownload(url, options);
    return { bytes: result.bytes, contentType: result.contentType };
  };
}
