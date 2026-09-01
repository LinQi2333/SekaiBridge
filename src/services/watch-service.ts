import type { WatchedAccount } from '../domain/watched-account.js';
import { TweetRepository } from '../repositories/tweet-repository.js';
import { WatchRepository } from '../repositories/watch-repository.js';
import { AlreadyExistsError, NotFoundError, ValidationError } from './errors.js';

/** 监听账户管理（规格 §5 / §9 / §25）。 */
export interface WatchService {
  list(): WatchedAccount[];
  add(screenName: string): WatchedAccount;
  /** 删除监听并清空该账号的全部历史推文；返回删除数与清理推文数。 */
  remove(screenName: string): { removed: boolean; tweetsDeleted: number };
  enable(screenName: string): WatchedAccount;
  disable(screenName: string): WatchedAccount;
  /** 设为默认账号（列表/刷新等命令未指定账号时使用）。 */
  setDefault(screenName: string): WatchedAccount;
  /** 当前默认账号；未设置时返回 null。 */
  getDefault(): WatchedAccount | null;
}

export const WATCH_SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/** 规范化屏幕名：去 @、去空白、转小写（Twitter 用户名大小写不敏感）。 */
export function normalizeScreenName(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export class SqliteWatchService implements WatchService {
  constructor(
    private readonly repository: WatchRepository,
    private readonly tweets: TweetRepository,
  ) {}

  list(): WatchedAccount[] {
    return this.repository.list();
  }

  add(screenName: string): WatchedAccount {
    const normalized = normalizeScreenName(screenName);
    if (!WATCH_SCREEN_NAME_PATTERN.test(normalized)) {
      throw new ValidationError(
        `无效的账号名: ${JSON.stringify(screenName)}（只允许 1-15 位字母、数字、下划线）`,
      );
    }
    if (this.repository.findByScreenName(normalized)) {
      throw new AlreadyExistsError(`账号已存在: @${normalized}`);
    }
    const account = this.repository.create(normalized);
    // 第一个账号自动设为默认
    if (this.repository.list().length === 1) {
      this.repository.setDefault(normalized);
    }
    return this.repository.findByScreenName(normalized) as WatchedAccount;
  }

  remove(screenName: string): { removed: boolean; tweetsDeleted: number } {
    const normalized = normalizeScreenName(screenName);
    const account = this.repository.findByScreenName(normalized);
    if (!account) {
      return { removed: false, tweetsDeleted: 0 };
    }
    // 先清推文（translations/publish_records/notifications 由外键级联），再删监听
    const tweetsDeleted = this.tweets.deleteByAccount(normalized);
    this.repository.removeByScreenName(normalized);
    // 删除的是默认账号时，提升剩余第一个为默认
    if (account.isDefault) {
      this.repository.promoteFirstAsDefault();
    }
    return { removed: true, tweetsDeleted };
  }

  enable(screenName: string): WatchedAccount {
    return this.setEnabled(screenName, true);
  }

  disable(screenName: string): WatchedAccount {
    return this.setEnabled(screenName, false);
  }

  setDefault(screenName: string): WatchedAccount {
    const normalized = normalizeScreenName(screenName);
    if (!this.repository.findByScreenName(normalized)) {
      throw new NotFoundError(`账号未在监听: @${normalized}`);
    }
    return this.repository.setDefault(normalized) as WatchedAccount;
  }

  getDefault(): WatchedAccount | null {
    return this.repository.list().find((a) => a.isDefault) ?? null;
  }

  private setEnabled(screenName: string, enabled: boolean): WatchedAccount {
    const account = this.repository.findByScreenName(normalizeScreenName(screenName));
    if (!account) {
      throw new NotFoundError(`账号未在监听: @${normalizeScreenName(screenName)}`);
    }
    return this.repository.setEnabled(account.id, enabled) as WatchedAccount;
  }
}
