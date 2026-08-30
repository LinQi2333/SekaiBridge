import path from 'node:path';
import process from 'node:process';

/**
 * 应用配置。
 *
 * 所有 secret（Bilibili Cookie 等）只从环境变量读取，
 * 禁止写入 Git、源码、日志与错误消息。
 */
export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';

  /** SQLite 数据库文件路径（相对路径基于进程工作目录解析）。 */
  databasePath: string;

  /** 媒体缓存根目录（截图 / 原始图片 / 视频封面，规格 §47）。 */
  cacheRoot: string;

  /** TweetToaster 独立服务地址。 */
  tweettoasterUrl: string;

  /** Twitter 轮询间隔（秒）。 */
  twitterPollInterval: number;

  /** 单推来源检查间隔（秒）。 */
  sourceCheckInterval: number;

  /** 首次监听账户时的行为。 */
  bootstrapMode: 'latest_only';

  /** OneBot WebSocket 地址。 */
  onebotWsUrl: string;

  /** OneBot access token（可选）。 */
  onebotAccessToken: string;

  /** 允许接收消息的 QQ 群号。 */
  qqGroupIds: string[];

  /** 管理员 QQ 号。 */
  qqAdminIds: string[];

  /** Bilibili 登录 Cookie（secret）。 */
  biliSessdata: string;
  biliJct: string;
  biliDedeuserid: string;

  /** 发布模式：MVP 仅 manual。 */
  publishMode: 'manual';
}

export type Env = Record<string, string | undefined>;

function parseIntStrict(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`config: ${name} 必须是大于等于 0 的整数，实际值: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseCsv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 从环境变量加载配置。不读取文件系统，方便测试直接注入。
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'production';
  if (nodeEnv !== 'development' && nodeEnv !== 'production' && nodeEnv !== 'test') {
    throw new Error(`config: NODE_ENV 只允许 development / production / test，实际值: ${JSON.stringify(nodeEnv)}`);
  }

  const bootstrapMode = env.BOOTSTRAP_MODE ?? 'latest_only';
  if (bootstrapMode !== 'latest_only') {
    throw new Error(`config: BOOTSTRAP_MODE 仅支持 latest_only，实际值: ${JSON.stringify(bootstrapMode)}`);
  }

  const publishMode = env.PUBLISH_MODE ?? 'manual';
  if (publishMode !== 'manual') {
    throw new Error(`config: PUBLISH_MODE 仅支持 manual，实际值: ${JSON.stringify(publishMode)}`);
  }

  return {
    nodeEnv,
    databasePath: path.resolve(env.DATABASE_PATH ?? './data/app.db'),
    cacheRoot: path.resolve(env.CACHE_ROOT ?? './cache'),
    tweettoasterUrl: env.TWEETTOASTER_URL ?? 'http://tweettoaster:8082',
    twitterPollInterval: parseIntStrict(env.TWITTER_POLL_INTERVAL, 60, 'TWITTER_POLL_INTERVAL'),
    sourceCheckInterval: parseIntStrict(env.SOURCE_CHECK_INTERVAL, 1800, 'SOURCE_CHECK_INTERVAL'),
    bootstrapMode,
    onebotWsUrl: env.ONEBOT_WS_URL ?? 'ws://127.0.0.1:3001',
    onebotAccessToken: env.ONEBOT_ACCESS_TOKEN ?? '',
    qqGroupIds: parseCsv(env.QQ_GROUP_IDS),
    qqAdminIds: parseCsv(env.QQ_ADMIN_IDS),
    biliSessdata: env.BILI_SESSDATA ?? '',
    biliJct: env.BILI_JCT ?? '',
    biliDedeuserid: env.BILI_DEDEUSERID ?? '',
    publishMode,
  };
}

/** 便捷：dotenv 已加载时读取当前进程环境。 */
export function loadConfigFromEnv(): AppConfig {
  return loadConfig(process.env);
}
