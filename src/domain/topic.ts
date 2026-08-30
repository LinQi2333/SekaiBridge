/** Bilibili 话题（规格 §31）。 */
export interface BiliTopic {
  id: number;
  /** 群内使用的别名，如 hololive。 */
  alias: string;
  /** Bilibili 话题 ID。 */
  biliTopicId: string;
  /** Bilibili 话题名称。 */
  name: string;
  enabled: boolean;
  createdAt: string;
}

export interface NewBiliTopicInput {
  alias: string;
  biliTopicId: string;
  name: string;
}
