/** QQ 通知记录（NoneBot2 拉取发送，规格 §42）。 */
export type QqNotificationStatus = 'PENDING' | 'SENT';

export interface QqNotification {
  id: number;
  tweetId: number;
  /** 最终展示文本（不含推文原文正文，规格 §42 / §51）。 */
  text: string;
  screenshotPath: string | null;
  /** 视频封面路径列表（JSON 存储，可为空）。 */
  videoThumbnails: string[];
  status: QqNotificationStatus;
  createdAt: string;
  sentAt: string | null;
}
