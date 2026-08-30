import { NotImplementedError } from './errors.js';

/**
 * 媒体处理（规格 §16 / §18 / §47 / §48）—— Phase 4 实现。
 * - 识别 photo / video / gif；
 * - 缓存 Twitter 原始 photo（Bilibili 发布用）；
 * - 视频只下载默认封面，不下载视频本体；
 * - 远程下载安全约束（timeout / 大小限制 / Content-Type / 格式白名单）。
 */
export interface MediaService {
  /** 缓存推文的 photo 媒体，返回缓存文件路径列表。 */
  cachePhotos(tweetId: number): Promise<string[]>;
  /** 缓存推文视频的默认封面（不下载视频本体），返回封面路径列表。 */
  cacheVideoThumbnails(tweetId: number): Promise<string[]>;
}

export class StubMediaService implements MediaService {
  cachePhotos(_tweetId: number): Promise<string[]> {
    throw new NotImplementedError('MediaService（Phase 4）');
  }

  cacheVideoThumbnails(_tweetId: number): Promise<string[]> {
    throw new NotImplementedError('MediaService（Phase 4）');
  }
}
