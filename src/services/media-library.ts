import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tweet } from '../domain/tweet.js';
import { parseMedia } from '../domain/tweet.js';
import { EXT_BY_CONTENT_TYPE, IMAGE_CONTENT_TYPES, safeDownload } from '../media/safe-download.js';
import type { MediaFetcher } from '../media/media-fetcher.js';
import {
  mediaFileName,
  mediaRoot,
  parseMediaFileName,
  tweetMediaDir,
  type MediaKind,
  type StoredMedia,
} from '../media/media-store.js';
import type { TweetRepository } from '../repositories/tweet-repository.js';
import { log } from '../logger.js';
import { NotFoundError, NotImplementedError } from './errors.js';
import { toPortablePath } from './screenshot-service.js';

export interface SkippedMedia {
  name: string;
  reason: string;
}

export interface CacheMediaResult {
  files: StoredMedia[];
  skipped: SkippedMedia[];
}

/**
 * 推文媒体库：统一管理 cache/media/<推文ID>/ 下的图片与视频。
 * - 新推文入库时即下载（图片 `name=orig` 最高画质；视频取最高码率 mp4）
 * - `ensureMedia` 是"本地优先"入口：本地已下载齐 → 直接读本地（不联网）；
 *   未下载或不完整 → 才执行下载
 * - 发布会话直接读取本地文件，不再重复下载
 * - `!媒体` 指令复用同一批文件上传群文件
 * - `cleanupOlderThan` 负责按天清理（截图不受影响）
 */
export interface MediaLibrary {
  /** 下载并缓存该推文媒体（已存在的文件跳过；会联网，用于补齐）。 */
  cacheMedia(tweetId: number): Promise<CacheMediaResult>;
  /** 本地优先：已下载齐直接返回本地文件，未下载/不完整才下载。 */
  ensureMedia(tweetId: number): Promise<CacheMediaResult>;
  /** 列出已缓存的媒体文件（按类型/序号排序）。 */
  listMedia(tweetId: number): Promise<StoredMedia[]>;
  /** 取图片文件：本地已齐直接用；缺失则补齐（发布用）。 */
  ensurePhotos(tweetId: number): Promise<StoredMedia[]>;
  /** 清理超过天数的媒体文件与空目录，返回清理数量。 */
  cleanupOlderThan(days: number): Promise<{ files: number; dirs: number }>;
}

export interface MediaLibraryOptions {
  tweets: TweetRepository;
  cacheRoot: string;
  /** 媒体获取策略（Twitter 图片走 TweetToaster 代理，失败回退直连）。 */
  fetcher: MediaFetcher;
  fetchImpl?: typeof fetch;
  /** FxTwitter API 根地址（取原始视频地址）。 */
  fxBaseUrl: string;
  /** 单个媒体文件字节上限。 */
  maxBytes: number;
  /** 下载超时（毫秒）。 */
  timeoutMs?: number;
}

interface RemoteMediaItem {
  kind: MediaKind;
  url: string;
}

export class DefaultMediaLibrary implements MediaLibrary {
  private readonly tweets: TweetRepository;
  private readonly cacheRoot: string;
  private readonly fetcher: MediaFetcher;
  private readonly fetchImpl: typeof fetch;
  private readonly fxBaseUrl: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: MediaLibraryOptions) {
    this.tweets = options.tweets;
    this.cacheRoot = options.cacheRoot;
    this.fetcher = options.fetcher;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.fxBaseUrl = options.fxBaseUrl.replace(/\/+$/, '');
    this.maxBytes = options.maxBytes;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async cacheMedia(tweetId: number): Promise<CacheMediaResult> {
    const tweet = this.#requireTweet(tweetId);
    const dir = tweetMediaDir(this.cacheRoot, tweet.id);
    const existing = await this.listMedia(tweet.id);
    const items = (await this.#remoteMedia(tweet)) ?? this.#localPhotos(tweet);

    const files: StoredMedia[] = [];
    const skipped: SkippedMedia[] = [];
    const counters: Record<MediaKind, number> = { photo: 0, video: 0 };

    for (const item of items) {
      const index = (counters[item.kind] += 1);
      const baseName = mediaFileName(item.kind, index, '');
      const cached = existing.find((file) => file.kind === item.kind && file.index === index);
      if (cached) {
        files.push(cached);
        continue;
      }
      try {
        const { bytes, contentType } = await this.#download(item);
        const ext = extensionFor(item.kind, contentType);
        const name = mediaFileName(item.kind, index, ext);
        if (bytes.byteLength > this.maxBytes) {
          skipped.push({ name, reason: `超过单文件上限 ${mb(this.maxBytes)}MB` });
          continue;
        }
        await fs.mkdir(dir, { recursive: true });
        const absPath = path.join(dir, name);
        await fs.writeFile(absPath, bytes);
        const stat = await fs.stat(absPath);
        files.push({
          kind: item.kind,
          index,
          name,
          absPath,
          relPath: toPortablePath(path.relative(this.cacheRoot, absPath)),
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        log('media.cache.complete', `#${tweet.id} ${name} ${stat.size}B`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skipped.push({ name: baseName, reason: message });
        log('media.cache.failed', `#${tweet.id} ${baseName}: ${message}`);
      }
    }

    return { files: sortMedia(files), skipped };
  }

  /**
   * 本地优先入口（`!媒体` 用）：
   * - 本地已下载齐（数量达到库内记录的张数）→ 直接返回本地文件，完全不联网
   * - 本地没有 / 不完整（含之前下载失败的）→ 才走 cacheMedia 补齐
   */
  async ensureMedia(tweetId: number): Promise<CacheMediaResult> {
    const tweet = this.#requireTweet(tweetId);
    const local = await this.listMedia(tweetId);
    if (isComplete(local, expectedMediaCounts(tweet))) {
      log('media.cache.reuse', `#${tweetId} 使用本地已有 ${local.length} 个文件（不下载）`);
      return { files: local, skipped: [] };
    }
    return this.cacheMedia(tweetId);
  }

  async listMedia(tweetId: number): Promise<StoredMedia[]> {
    const dir = tweetMediaDir(this.cacheRoot, tweetId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const files: StoredMedia[] = [];
    for (const name of names) {
      const parsed = parseMediaFileName(name);
      if (!parsed) {
        continue;
      }
      const absPath = path.join(dir, name);
      const stat = await fs.stat(absPath);
      files.push({
        kind: parsed.kind,
        index: parsed.index,
        name,
        absPath,
        relPath: toPortablePath(path.relative(this.cacheRoot, absPath)),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
    return sortMedia(files);
  }

  async ensurePhotos(tweetId: number): Promise<StoredMedia[]> {
    const tweet = this.#requireTweet(tweetId);
    const expected = expectedMediaCounts(tweet).photo;
    const photos = (await this.listMedia(tweetId)).filter((file) => file.kind === 'photo');
    // 本地图片已齐（数量不少于库内记录的图片数）→ 直接用，不联网
    if (photos.length > 0 && photos.length >= expected) {
      return photos;
    }
    const result = await this.cacheMedia(tweetId);
    const downloaded = result.files.filter((file) => file.kind === 'photo');
    const failures = result.skipped.filter((item) => item.name.startsWith('photo'));
    if (downloaded.length < expected || failures.length > 0) {
      throw new Error(`原图下载不完整（${downloaded.length}/${expected}），请重试`);
    }
    return downloaded;
  }

  async cleanupOlderThan(days: number): Promise<{ files: number; dirs: number }> {
    if (days <= 0) {
      return { files: 0, dirs: 0 };
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const root = mediaRoot(this.cacheRoot);
    let dirsIn: string[];
    try {
      dirsIn = await fs.readdir(root);
    } catch {
      return { files: 0, dirs: 0 };
    }
    let files = 0;
    let dirs = 0;
    for (const entry of dirsIn) {
      const dir = path.join(root, entry);
      let names: string[];
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) continue;
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const absPath = path.join(dir, name);
        try {
          const stat = await fs.stat(absPath);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(absPath);
            files += 1;
          }
        } catch {
          // 忽略单个文件错误
        }
      }
      try {
        const rest = await fs.readdir(dir);
        if (rest.length === 0) {
          await fs.rmdir(dir);
          dirs += 1;
        }
      } catch {
        // 目录已被删除等
      }
    }
    if (files > 0 || dirs > 0) {
      log('media.cache.cleanup', `清理 ${files} 个文件、${dirs} 个空目录（阈值 ${days} 天）`);
    }
    return { files, dirs };
  }

  #requireTweet(tweetId: number): Tweet {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    return tweet;
  }

  /** 下载单个媒体：图片优先 TweetToaster 代理（12MB 上限），其余直连。 */
  async #download(item: RemoteMediaItem): Promise<{ bytes: Buffer; contentType: string }> {
    if (item.kind === 'photo') {
      try {
        return await this.fetcher(item.url);
      } catch {
        // 代理失败（如超过其 12MB 上限）回退直连
      }
    }
    const allowed =
      item.kind === 'video' ? ['video/mp4', 'application/octet-stream'] : IMAGE_CONTENT_TYPES;
    const result = await safeDownload(item.url, {
      maxBytes: this.maxBytes,
      allowedContentTypes: allowed,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    return { bytes: result.bytes, contentType: result.contentType };
  }

  /** 经 FxTwitter 取媒体清单（原图 + 最高码率 mp4）；失败返回 null（回退库内图片）。 */
  async #remoteMedia(tweet: Tweet): Promise<RemoteMediaItem[] | null> {
    try {
      const response = await this.fetchImpl(`${this.fxBaseUrl}/status/${tweet.xTweetId}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { status?: { media?: { all?: unknown[] } } };
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
      log('media.provider_failed', String(error));
      return null;
    }
  }

  /** FxTwitter 不可用时的兜底：只用库里已有的 photo。 */
  #localPhotos(tweet: Tweet): RemoteMediaItem[] {
    return parseMedia(tweet.mediaJson)
      .filter((item) => item.type === 'photo' && typeof item.url === 'string')
      .map((item) => ({ kind: 'photo' as const, url: originalQualityUrl(item.url) }));
  }
}

/**
 * 从库内 mediaJson 统计该推文应有的媒体数量（纯离线，不联网）。
 * 用于判断本地缓存是否已经"下载齐"。
 */
export function expectedMediaCounts(tweet: Tweet): { photo: number; video: number } {
  const media = parseMedia(tweet.mediaJson);
  return {
    photo: media.filter((item) => item.type === 'photo' && typeof item.url === 'string').length,
    video: media.filter((item) => item.type === 'video').length,
  };
}

/** 本地文件数量是否已达到库内记录（>= 期望张数即视为已下载）。 */
function isComplete(files: StoredMedia[], expected: { photo: number; video: number }): boolean {
  if (files.length === 0) {
    return false;
  }
  const photo = files.filter((file) => file.kind === 'photo').length;
  const video = files.filter((file) => file.kind === 'video').length;
  return photo >= expected.photo && video >= expected.video;
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
  return (
    mp4s.reduce((best, cur) => ((cur.bitrate ?? 0) > (best.bitrate ?? 0) ? cur : best)).url ?? null
  );
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

function extensionFor(kind: MediaKind, contentType: string): string {
  if (kind === 'video') {
    return 'mp4';
  }
  return EXT_BY_CONTENT_TYPE[contentType] ?? 'jpg';
}

function sortMedia(files: StoredMedia[]): StoredMedia[] {
  return files.sort((a, b) =>
    a.kind === b.kind ? a.index - b.index : a.kind === 'photo' ? -1 : 1,
  );
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export class StubMediaLibrary implements MediaLibrary {
  cacheMedia(_tweetId: number): Promise<CacheMediaResult> {
    throw new NotImplementedError('MediaLibrary 未接线');
  }

  ensureMedia(_tweetId: number): Promise<CacheMediaResult> {
    throw new NotImplementedError('MediaLibrary 未接线');
  }

  listMedia(_tweetId: number): Promise<StoredMedia[]> {
    throw new NotImplementedError('MediaLibrary 未接线');
  }

  ensurePhotos(_tweetId: number): Promise<StoredMedia[]> {
    throw new NotImplementedError('MediaLibrary 未接线');
  }

  cleanupOlderThan(_days: number): Promise<{ files: number; dirs: number }> {
    throw new NotImplementedError('MediaLibrary 未接线');
  }
}
