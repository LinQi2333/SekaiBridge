import { NotImplementedError } from './errors.js';

/**
 * 推文截图（规格 §15 / §47）—— Phase 4 实现。
 * 通过 TweetToaster /api/render 生成推文截图，用于发送 QQ 群。
 * 推文截图 ≠ Twitter 原始图片。
 */
export interface ScreenshotService {
  /** 生成截图并保存到 cache/screenshots/<tweet-id>.png，返回路径。 */
  render(tweetId: number): Promise<string>;
}

export class StubScreenshotService implements ScreenshotService {
  render(_tweetId: number): Promise<string> {
    throw new NotImplementedError('ScreenshotService（Phase 4）');
  }
}
