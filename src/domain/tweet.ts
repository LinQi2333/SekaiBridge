import type { SourceStatus, WorkflowStatus } from './workflow.js';

/** Twitter 媒体类型（规格 §16）。 */
export type MediaType = 'photo' | 'video' | 'gif';

/** Twitter 媒体（规格 §16：type / url / thumbnail_url / width / height / alt）。 */
export interface TweetMedia {
  type: MediaType;
  url: string;
  thumbnail_url?: string | null;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
}

/** 创建推文时的输入（来自 TweetToaster 标准化数据）。 */
export interface NewTweetInput {
  /** Twitter Snowflake ID，用于数据源识别与去重。 */
  xTweetId: string;
  authorScreenName: string;
  authorName?: string | null;
  tweetUrl: string;
  originalText: string;
  /** Twitter 原始发布时间。 */
  createdAtX?: string | null;
  /** 媒体列表，序列化进 media_json。 */
  media?: TweetMedia[];
  /** 原始 Provider 响应（FxTwitter / FxEmbed）。 */
  rawJson?: unknown;
}

/** 推文（本地任务，规格 §10）。 */
export interface Tweet {
  /** 本地任务编号，QQ 群与未来 Web 默认使用（#152）。 */
  id: number;
  xTweetId: string;
  authorScreenName: string;
  authorName: string | null;
  tweetUrl: string;
  originalText: string;
  createdAtX: string | null;
  detectedAt: string;
  rawJson: string | null;
  mediaJson: string | null;
  screenshotPath: string | null;
  workflowStatus: WorkflowStatus;
  sourceStatus: SourceStatus;
  lastError: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 从 media_json 解析出的媒体列表。 */
export function parseMedia(mediaJson: string | null): TweetMedia[] {
  if (!mediaJson) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(mediaJson);
    return Array.isArray(parsed) ? (parsed as TweetMedia[]) : [];
  } catch {
    return [];
  }
}

export function hasVideo(tweet: Pick<Tweet, 'mediaJson'>): boolean {
  return parseMedia(tweet.mediaJson).some((media) => media.type === 'video' || media.type === 'gif');
}

/** 只返回 photo 媒体（Bilibili 只上传 photo，规格 §21）。 */
export function photoMedia(tweet: Pick<Tweet, 'mediaJson'>): TweetMedia[] {
  return parseMedia(tweet.mediaJson).filter((media) => media.type === 'photo');
}
