import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tweet } from '../domain/tweet.js';
import { parseMedia } from '../domain/tweet.js';
import { EXT_BY_CONTENT_TYPE, IMAGE_CONTENT_TYPES, safeDownload } from '../media/safe-download.js';
import type { MediaFetcher } from '../media/media-fetcher.js';
import type { TweetRepository } from '../repositories/tweet-repository.js';
import { log } from '../logger.js';
import { NotFoundError, NotImplementedError } from './errors.js';
import { toPortablePath } from './screenshot-service.js';

/** 可供上传/下载的媒体文件（相对 cacheRoot 的可移植路径）。 */
export interface ExportedMedia {
  path: string;
  /** QQ 群文件里展示的文件名。 */
  name: string;
  kind: 'photo' | 'video';
  bytes: number;
}

export interface SkippedMedia {
  name: string;
  reason: string;
}

export interface MediaExportResult {
  files: ExportedMedia[];
  skipped: SkippedMedia[];
}

/**
 * 推文媒体导出（`!媒体` 指令）：下载推文原图与视频到本地缓存，供 QQ 侧上传群文件。
 * - 图片：`name=orig` 最高画质原图（优先 TweetToaster 媒体代理，失败回退直连）
 * - 视频：经 FxTwitter 取最高码率 mp4 直链后直连下载（TweetToaster 代理仅支持图片）
 * - 超过群文件上限的文件不下载，记入 skipped 并说明原因
 */
export interface MediaExportService {
  exportMedia(tweetId: number): Promise<MediaExportResult>;
}

export interface MediaExportServiceOptions {
  tweets: TweetRepository;
  cacheRoot: string;
  /** 媒体获取策略（Twitter 图片走 TweetToaster 代理）。 */
  fetcher: MediaFetcher;
  fetchImpl?: typeof fetch;
  /** FxTwitter API 根地址。 */
  fxBaseUrl: string;
  /** 单文件字节上限。 */
  maxBytes: number;
  /** 群文件字节上限（超过则跳过）。 */
  groupFileMaxBytes: number;
}

interface RemoteMediaItem {
  kind: 'photo' | 'video';
  url: string;
}

export class DefaultMediaExportService implements MediaExportService {
  private readonly tweets: TweetRepository;
  private readonly cacheRoot: string;
  private readonly fetcher: MediaFetcher;
  private readonly fetchImpl: typeof fetch;
  private readonly fxBaseUrl: string;
  private readonly maxBytes: number;
  private readonly groupFileMaxBytes: number;

  constructor(options: MediaExportServiceOptions) {
    this.tweets = options.tweets;
    this.cacheRoot = options.cacheRoot;
    this.fetcher = options.fetcher;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.fxBaseUrl = options.fxBaseUrl.replace(/\/+$/, '');
    this.maxBytes = options.maxBytes;
    this.groupFileMaxBytes = options.groupFileMaxBytes;
  }

  async exportMedia(tweetId: number): Promise<MediaExportResult> {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    const dir = path.join(this.cacheRoot, 'exports', String(tweet.id));
    const cached = await this.#listExported(dir);
    if (cached.length > 0) {
      return { files: cached, skipped: [] };
    }

    const items = (await this.#remoteMedia(tweet)) ?? this.#localPhotos(tweet);
    await fs.mkdir(dir, { recursive: true });

    const files: ExportedMedia[] = [];
    const skipped: SkippedMedia[] = [];
    let photoIndex = 0;
    let videoIndex = 0;

    for (const item of items) {
      const index = item.kind === 'photo' ? (photoIndex += 1) : (videoIndex += 1);
      const baseName = `${sanitize(tweet.authorScreenName)}_${tweet.seq}_${item.kind === 'photo' ? 'photo' : 'video'}${index}`;
      try {
        const { bytes, contentType } = await this.#download(item);
        const ext = extensionFor(item.kind, contentType);
        const name = `${baseName}.${ext}`;
        if (bytes.byteLength > this.groupFileMaxBytes) {
          skipped.push({ name, reason: `超过群文件上限 ${mb(this.groupFileMaxBytes)}MB` });
          continue;
        }
        const filePath = path.join(dir, name);
        await fs.writeFile(filePath, bytes);
        files.push({
          path: toPortablePath(path.relative(this.cacheRoot, filePath)),
          name,
          kind: item.kind,
          bytes: bytes.byteLength,
        });
        log('media.export.complete', `#${tweet.id} ${name} ${bytes.byteLength}B`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skipped.push({ name: baseName, reason: message });
        log('media.export.failed', `#${tweet.id} ${baseName}: ${message}`);
      }
    }
    return { files, skipped };
  }

  /** 下载单个媒体：图片优先 TweetToaster 代理，视频直连。 */
  async #download(item: RemoteMediaItem): Promise<{ bytes: Buffer; contentType: string }> {
    if (item.kind === 'photo') {
      try {
        return await this.fetcher(item.url);
      } catch {
        // TweetToaster 代理有 12MB 上限，失败时回退直连
      }
    }
    const allowed = item.kind === 'video' ? ['video/mp4', 'application/octet-stream'] : IMAGE_CONTENT_TYPES;
    const result = await safeDownload(item.url, {
      maxBytes: this.maxBytes,
      allowedContentTypes: allowed,
      fetchImpl: this.fetchImpl,
    });
    return { bytes: result.bytes, contentType: result.contentType };
  }

  /** 经 FxTwitter 取媒体清单（原图 + 最高码率 mp4）；失败返回 null（回退本地 photo）。 */
  async #remoteMedia(tweet: Tweet): Promise<RemoteMediaItem[] | null> {
    try {
      const response = await this.fetchImpl(`${this.fxBaseUrl}/status/${tweet.xTweetId}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as {
        status?: { media?: { all?: unknown[] } };
      };
      const all = payload.status?.media?.all;
      if (!Array.isArray(all)) {
        return null;
      }
      const items: RemoteMediaItem[] = [];
      for (const raw of all) {
        const item = raw as {
          type?: string;
          url?: string;
          formats?: { url?: string; container?: string; bitrate?: number }[];
        };
        if (item.type === 'photo' && typeof item.url === 'string') {
          items.push({ kind: 'photo', url: originalQualityUrl(item.url) });
        } else if (item.type === 'video') {
          const best = bestMp4(item.formats ?? []);
          if (best) {
            items.push({ kind: 'video', url: best });
          }
        }
      }
      return items.length > 0 ? items : null;
    } catch (error) {
      log('media.export.provider_failed', String(error));
      return null;
    }
  }

  /** FxTwitter 不可用时的兜底：只用库里已有的 photo（最高画质）。 */
  #localPhotos(tweet: Tweet): RemoteMediaItem[] {
    return parseMedia(tweet.mediaJson)
      .filter((item) => item.type === 'photo' && typeof item.url === 'string')
      .map((item) => ({ kind: 'photo' as const, url: originalQualityUrl(item.url) }));
  }

  async #listExported(dir: string): Promise<ExportedMedia[]> {
    try {
      const names = await fs.readdir(dir);
      const files: ExportedMedia[] = [];
      for (const name of names) {
        const stat = await fs.stat(path.join(dir, name));
        files.push({
          path: toPortablePath(path.join('exports', path.basename(dir), name)),
          name,
          kind: name.includes('_video') ? 'video' : 'photo',
          bytes: stat.size,
        });
      }
      return files;
    } catch {
      return [];
    }
  }
}

/** 从 mp4 变体里挑码率最高的一条。 */
export function bestMp4(
  formats: { url?: string; container?: string; bitrate?: number }[],
): string | null {
  const mp4s = formats.filter(
    (f) => f.container === 'mp4' && typeof f.url === 'string' && f.url.length > 0,
  );
  if (mp4s.length === 0) {
    return null;
  }
  return mp4s.reduce((best, cur) => ((cur.bitrate ?? 0) > (best.bitrate ?? 0) ? cur : best)).url ?? null;
}

/** Twitter 图片取原始格式的最高画质（去掉 format= 转换参数）。 */
export function originalQualityUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/\.twimg\.com$/i.test(parsed.hostname)) {
      return url;
    }
    parsed.searchParams.delete('format');
    parsed.searchParams.set('name', 'orig');
    return parsed.toString();
  } catch {
    return url;
  }
}

function extensionFor(kind: 'photo' | 'video', contentType: string): string {
  if (kind === 'video') {
    return 'mp4';
  }
  return EXT_BY_CONTENT_TYPE[contentType] ?? 'jpg';
}

function sanitize(value: string): string {
  return value.replace(/[^\w.-]/g, '_');
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export class StubMediaExportService implements MediaExportService {
  exportMedia(_tweetId: number): Promise<MediaExportResult> {
    throw new NotImplementedError('MediaExportService 未接线');
  }
}
