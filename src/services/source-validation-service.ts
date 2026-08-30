import { NotImplementedError } from './errors.js';

/**
 * 来源检查（规格 §12 / §13 / §50）—— Phase 5 实现。
 * 通过单推检查（getTweet）明确确认删除，绝不因"不在 timeline"判定删除。
 */
export interface SourceValidationService {
  /** 检查一批待检查推文，返回本次标记为 SOURCE_DELETED 的推文 id。 */
  checkDue(): Promise<number[]>;
  /** 对单条推文立即刷新检查（/查看 时使用，规格 §12）。 */
  checkTweet(tweetId: number): Promise<boolean>;
}

export class StubSourceValidationService implements SourceValidationService {
  checkDue(): Promise<number[]> {
    throw new NotImplementedError('SourceValidationService（Phase 5）');
  }

  checkTweet(_tweetId: number): Promise<boolean> {
    throw new NotImplementedError('SourceValidationService（Phase 5）');
  }
}
