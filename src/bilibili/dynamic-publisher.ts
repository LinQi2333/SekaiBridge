import type { BilibiliClient } from './client.js';
import type { UploadedImage } from './image-upload.js';

/** 动态发布器（PublishService 依赖，便于测试注入 mock）。 */
export interface DynamicPublisher {
  publishDynamic(input: {
    text: string;
    pics?: UploadedImage[];
    topicId?: string | null;
    topicName?: string | null;
  }): Promise<string>;
}

export class BilibiliDynamicPublisher implements DynamicPublisher {
  constructor(private readonly client: BilibiliClient) {}

  publishDynamic(input: {
    text: string;
    pics?: UploadedImage[];
    topicId?: string | null;
    topicName?: string | null;
  }): Promise<string> {
    return this.client.publishDynamic(input);
  }
}
