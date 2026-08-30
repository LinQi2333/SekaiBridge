import type { BilibiliClient } from './client.js';

/** 图片上传器（PublishService 依赖，便于测试注入 mock）。 */
export interface ImageUploader {
  uploadImage(buffer: Buffer, filename: string): Promise<string>;
}

export class BilibiliImageUploader implements ImageUploader {
  constructor(private readonly client: BilibiliClient) {}

  uploadImage(buffer: Buffer, filename: string): Promise<string> {
    return this.client.uploadImage(buffer, filename);
  }
}
