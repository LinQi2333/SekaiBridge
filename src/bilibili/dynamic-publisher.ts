import type { BilibiliClient } from './client.js';

/** 动态发布器（PublishService 依赖，便于测试注入 mock）。 */
export interface DynamicPublisher {
  publishDynamic(input: { text: string; pics?: string[]; topicId?: string | null }): Promise<string>;
}

export class BilibiliDynamicPublisher implements DynamicPublisher {
  constructor(private readonly client: BilibiliClient) {}

  publishDynamic(input: {
    text: string;
    pics?: string[];
    topicId?: string | null;
  }): Promise<string> {
    return this.client.publishDynamic(input);
  }
}
