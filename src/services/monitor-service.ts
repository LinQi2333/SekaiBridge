import { NotImplementedError } from './errors.js';

/**
 * Twitter 监听（规格 §5 / §6 / §7 / §8）—— Phase 3 实现。
 * 负责：轮询 timeline、bootstrap（latest_only，不刷历史）、x_tweet_id 去重、分配本地编号。
 */
export interface MonitorService {
  /** 启动轮询循环（每个账户独立 jitter，规格 §6）。 */
  start(): void;
  stop(): void;
  /** 手动触发一轮检查（测试用）。 */
  pollOnce(): Promise<void>;
  isRunning(): boolean;
}

export class StubMonitorService implements MonitorService {
  start(): void {
    throw new NotImplementedError('MonitorService（Phase 3）');
  }

  stop(): void {
    throw new NotImplementedError('MonitorService（Phase 3）');
  }

  pollOnce(): Promise<void> {
    throw new NotImplementedError('MonitorService（Phase 3）');
  }

  isRunning(): boolean {
    return false;
  }
}
