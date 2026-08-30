/**
 * TweetToaster API 响应类型。
 *
 * 来源：cn-matsuri/TweetToaster（POST /api/tweet 的标准化输出）。
 * 注意：其 provider.normalizeMedia() 已把 video/gif 的 url 替换为默认封面
 * （thumbnail_url），即 media[].url 对视频而言就是封面地址。
 */

export type ToasterMediaType = 'photo' | 'video' | 'gif';

export interface ToasterMedia {
  type: ToasterMediaType;
  /** photo: 原图 URL；video / gif: 默认封面（thumbnail）URL。 */
  url: string;
  width: number;
  height: number;
  alt: string;
}

export interface ToasterAuthor {
  name: string;
  screenName: string;
  avatarUrl: string;
  verified: boolean;
}

export interface ToasterCounts {
  replies: number;
  reposts: number;
  likes: number;
  views: number | null;
}

export interface ToasterStatus {
  id: string;
  url: string;
  focal: boolean;
  relation: 'target' | 'context' | 'reply' | 'timeline';
  text: string;
  lang: string | null;
  createdAt: string | null;
  author: ToasterAuthor;
  counts: ToasterCounts;
  media: ToasterMedia[];
  quote: ToasterStatus | null;
  replyingTo: string | null;
  replyingToStatusId: string | null;
}

export type ToasterMode = 'conversation' | 'timeline';

export interface ToasterTweetResponse {
  id: string;
  canonicalUrl: string;
  mode: ToasterMode;
  query: { kind: string; screenName: string; canonicalUrl: string };
  /** tweets 数组中焦点（目标）推文的索引。 */
  focalIndex: number;
  tweets: ToasterStatus[];
}

/** /api/get_task=<id> 的任务状态。 */
export type ToasterTaskState = 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE';

export interface ToasterTaskResponse {
  task_id: string;
  state: ToasterTaskState;
  /** SUCCESS 时是文件名（图片位于 /cache/<result>.png）。 */
  result: string | null;
  error?: string;
}

/** /api/health 响应。 */
export interface ToasterHealthResponse {
  status: 'ok';
  version: string;
}
