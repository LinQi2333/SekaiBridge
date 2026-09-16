import path from 'node:path';

/** 媒体类型（图片 / 视频）。 */
export type MediaKind = 'photo' | 'video';

/** 推文媒体文件（统一存放于 cache/media/<推文ID>/）。 */
export interface StoredMedia {
  kind: MediaKind;
  /** 同类型内序号（从 1 开始）。 */
  index: number;
  /** 文件名，如 photo1.jpg / video1.mp4。 */
  name: string;
  /** 绝对路径（宿主机与容器同路径，QQ 侧可直接读取）。 */
  absPath: string;
  /** 相对 cacheRoot 的可移植路径（正斜杠）。 */
  relPath: string;
  bytes: number;
  /** 修改时间（毫秒），用于过期清理。 */
  mtimeMs: number;
}

/** 媒体根目录名：与截图目录 `screenshots/` 分开存放。 */
export const MEDIA_DIR = 'media';

export function mediaRoot(cacheRoot: string): string {
  return path.join(cacheRoot, MEDIA_DIR);
}

/** 某条推文的媒体目录：cache/media/<推文ID>/。 */
export function tweetMediaDir(cacheRoot: string, tweetId: number): string {
  return path.join(mediaRoot(cacheRoot), String(tweetId));
}

/** 统一媒体文件名：photo1.jpg / video1.mp4。 */
export function mediaFileName(kind: MediaKind, index: number, ext: string): string {
  return `${kind}${index}.${ext}`;
}

/** 解析媒体文件名；不匹配返回 null。 */
export function parseMediaFileName(
  name: string,
): { kind: MediaKind; index: number; ext: string } | null {
  const match = /^(photo|video)(\d+)\.([a-z0-9]+)$/i.exec(name);
  if (!match) {
    return null;
  }
  return {
    kind: match[1]!.toLowerCase() as MediaKind,
    index: Number.parseInt(match[2]!, 10),
    ext: match[3]!.toLowerCase(),
  };
}
