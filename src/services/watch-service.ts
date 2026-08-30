import type { WatchedAccount } from '../domain/watched-account.js';
import { AlreadyExistsError, NotFoundError, ValidationError } from './errors.js';
import { WatchRepository } from '../repositories/watch-repository.js';

/** 监听账户管理（规格 §5 / §9 / §25）。 */
export interface WatchService {
  list(): WatchedAccount[];
  add(screenName: string): WatchedAccount;
  remove(screenName: string): boolean;
  enable(screenName: string): WatchedAccount;
  disable(screenName: string): WatchedAccount;
}

export const WATCH_SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/** 规范化屏幕名：去 @、去空白、转小写（Twitter 用户名大小写不敏感）。 */
export function normalizeScreenName(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export class SqliteWatchService implements WatchService {
  constructor(private readonly repository: WatchRepository) {}

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
    return this.repository.create(normalized);
  }

  remove(screenName: string): boolean {
    return this.repository.removeByScreenName(normalizeScreenName(screenName));
  }

  enable(screenName: string): WatchedAccount {
    return this.setEnabled(screenName, true);
  }

  disable(screenName: string): WatchedAccount {
    return this.setEnabled(screenName, false);
  }

  private setEnabled(screenName: string, enabled: boolean): WatchedAccount {
    const account = this.repository.findByScreenName(normalizeScreenName(screenName));
    if (!account) {
      throw new NotFoundError(`账号未在监听: @${normalizeScreenName(screenName)}`);
    }
    return this.repository.setEnabled(account.id, enabled) as WatchedAccount;
  }
}
