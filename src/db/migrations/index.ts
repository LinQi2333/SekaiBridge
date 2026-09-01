import { up as initUp } from './001_init.js';
import { up as notificationsUp } from './002_notifications.js';
import { up as topicLibraryUp } from './003_topic_library.js';
import { up as perAccountUp } from './004_per_account.js';
import { up as normalizeAccountCaseUp } from './005_normalize_account_case.js';
import { up as dropTopicNameUp } from './006_drop_topic_name.js';

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
  { version: 3, name: 'topic_library', up: topicLibraryUp },
  { version: 4, name: 'per_account', up: perAccountUp },
  { version: 5, name: 'normalize_account_case', up: normalizeAccountCaseUp },
  { version: 6, name: 'drop_topic_name', up: dropTopicNameUp },
];
