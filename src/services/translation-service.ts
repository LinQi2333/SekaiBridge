import type { Translation, TranslationSubmitResult } from '../domain/translation.js';
import { normalizeTranslationText } from '../domain/translation.js';
import { WorkflowStatus } from '../domain/workflow.js';
import { TranslationRepository } from '../repositories/translation-repository.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { NotFoundError, ValidationError } from './errors.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * 翻译提交（规格 §28 / §29 / §30）。
 * QQ 与未来 Web 都调用同一个 submit()，核心逻辑不依赖 QQ 消息格式。
 */
export interface TranslationService {
  /** 提交最终翻译：版本号 +1，工作流状态转为 TRANSLATED。 */
  submit(tweetId: number, qqUserId: string, text: string): TranslationSubmitResult;
  /** 当前有效翻译（最新版本）。 */
  getLatest(tweetId: number): Translation | null;
  /** 全部版本历史（升序）。 */
  listVersions(tweetId: number): Translation[];
}

export class SqliteTranslationService implements TranslationService {
  constructor(
    private readonly tweets: TweetRepository,
    private readonly translations: TranslationRepository,
    private readonly workflow: WorkflowService,
  ) {}

  submit(tweetId: number, qqUserId: string, text: string): TranslationSubmitResult {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    const normalized = normalizeTranslationText(text);
    if (normalized.trim().length === 0) {
      throw new ValidationError('翻译内容不能为空');
    }
    if (qqUserId.trim().length === 0) {
      throw new ValidationError('缺少提交者身份');
    }

    const version = this.translations.nextVersion(tweetId);
    const translation = this.translations.create(tweetId, qqUserId.trim(), normalized, version);

    // 工作流：提交翻译后进入 TRANSLATED（已翻译则保持幂等）。
    const updated = this.workflow.transition(tweetId, WorkflowStatus.TRANSLATED);

    return { translation, workflowStatus: updated.workflowStatus };
  }

  getLatest(tweetId: number): Translation | null {
    this.assertTweetExists(tweetId);
    return this.translations.findLatest(tweetId);
  }

  listVersions(tweetId: number): Translation[] {
    this.assertTweetExists(tweetId);
    return this.translations.listByTweet(tweetId);
  }

  private assertTweetExists(tweetId: number): void {
    if (!this.tweets.findById(tweetId)) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
  }
}
