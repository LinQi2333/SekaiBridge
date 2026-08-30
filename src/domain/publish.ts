/** 发布记录状态。 */
export enum PublishStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

/** 发布记录（规格 §37）。 */
export interface PublishRecord {
  id: number;
  tweetId: number;
  /** 发布时使用的翻译版本 id。 */
  translationId: number | null;
  /** 发布成功后 Bilibili 动态 ID。 */
  biliDynamicId: string | null;
  /** 发布时使用的 Bilibili 话题 ID。 */
  biliTopicId: string | null;
  status: PublishStatus;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface NewPublishRecordInput {
  tweetId: number;
  translationId: number | null;
  status: PublishStatus;
  biliDynamicId?: string | null;
  biliTopicId?: string | null;
  lastError?: string | null;
}
