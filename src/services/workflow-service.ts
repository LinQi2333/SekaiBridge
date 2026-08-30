import type { WorkflowStatus } from '../domain/workflow.js';
import { canTransition } from '../domain/workflow.js';
import type { Tweet } from '../domain/tweet.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { IllegalTransitionError, NotFoundError } from './errors.js';

/**
 * 工作流状态转移（规格 §11）。
 * 所有改变 workflow_status 的路径都必须经过这里，保证转移合法。
 */
export interface WorkflowService {
  /** 转移到新状态；to 与当前相同视为幂等成功。 */
  transition(
    tweetId: number,
    to: WorkflowStatus,
    extra?: { lastError?: string | null; retryCount?: number },
  ): Tweet;
  getStatus(tweetId: number): Tweet;
}

export class SqliteWorkflowService implements WorkflowService {
  constructor(private readonly tweets: TweetRepository) {}

  transition(
    tweetId: number,
    to: WorkflowStatus,
    extra: { lastError?: string | null; retryCount?: number } = {},
  ): Tweet {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    if (tweet.workflowStatus !== to) {
      if (!canTransition(tweet.workflowStatus, to)) {
        throw new IllegalTransitionError(
          `非法状态转移: ${tweet.workflowStatus} → ${to}（#${tweetId}）`,
        );
      }
    }
    const updated = this.tweets.updateWorkflowStatus(tweetId, to, extra);
    if (!updated) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    return updated;
  }

  getStatus(tweetId: number): Tweet {
    const tweet = this.tweets.findById(tweetId);
    if (!tweet) {
      throw new NotFoundError(`推文不存在: #${tweetId}`);
    }
    return tweet;
  }
}
