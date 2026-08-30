import type { BilibiliClient } from './client.js';

/** 已上传的 Bilibili 图片信息（用于动态 pics[]）。 */
export interface UploadedImage {
  url: string;
  width: number;
  height: number;
  sizeKb: number;
}

/** 图片上传器（PublishService 依赖，便于测试注入 mock）。 */
export interface ImageUploader {
  uploadImage(buffer: Buffer, filename: string): Promise<UploadedImage>;
}

export class BilibiliImageUploader implements ImageUploader {
  constructor(private readonly client: BilibiliClient) {}

  uploadImage(buffer: Buffer, filename: string): Promise<UploadedImage> {
    return this.client.uploadImage(buffer, filename);
  }
}
