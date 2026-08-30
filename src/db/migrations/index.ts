import { up as initUp } from './001_init.js';
import { up as notificationsUp } from './002_notifications.js';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/**
 * 有序迁移注册表。新迁移追加到末尾，版本号递增。
 * 只允许追加，不允许修改已发布的迁移。
 */
export const migrations: readonly Migration[] = [
  { version: 1, name: 'init', up: initUp },
  { version: 2, name: 'notifications', up: notificationsUp },
];
