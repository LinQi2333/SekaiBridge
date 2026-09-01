/** Bilibili 话题（规格 §31）。 */
export interface BiliTopic {
  id: number;
  /** 群内使用的别名，如 hololive。 */
  alias: string;
  /** Bilibili 话题 ID（发布时按 id 挂话题）。 */
  biliTopicId: string;
  enabled: boolean;
  createdAt: string;
}

export interface NewBiliTopicInput {
  alias: string;
  biliTopicId: string;
}
