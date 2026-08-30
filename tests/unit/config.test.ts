import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

describe('loadConfig', () => {
  it('无环境变量时使用默认值', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('production');
    expect(config.databasePath).toMatch(/data[\\/]app\.db$/);
    expect(config.tweettoasterUrl).toBe('http://tweettoaster:8082');
    expect(config.twitterPollInterval).toBe(60);
    expect(config.sourceCheckInterval).toBe(1800);
    expect(config.bootstrapMode).toBe('latest_only');
    expect(config.onebotWsUrl).toBe('ws://127.0.0.1:3001');
    expect(config.qqGroupIds).toEqual([]);
    expect(config.qqAdminIds).toEqual([]);
    expect(config.publishMode).toBe('manual');
    expect(config.biliSessdata).toBe('');
  });

  it('解析数值配置', () => {
    const config = loadConfig({
      TWITTER_POLL_INTERVAL: '120',
      SOURCE_CHECK_INTERVAL: '900',
    });
    expect(config.twitterPollInterval).toBe(120);
    expect(config.sourceCheckInterval).toBe(900);
  });

  it('解析逗号分隔的 QQ 配置', () => {
    const config = loadConfig({
      QQ_GROUP_IDS: ' 10001, 10002 ,10003 ',
      QQ_ADMIN_IDS: '20001',
    });
    expect(config.qqGroupIds).toEqual(['10001', '10002', '10003']);
    expect(config.qqAdminIds).toEqual(['20001']);
  });

  it('非法数字抛错', () => {
    expect(() => loadConfig({ TWITTER_POLL_INTERVAL: 'abc' })).toThrow();
    expect(() => loadConfig({ TWITTER_POLL_INTERVAL: '-5' })).toThrow();
  });

  it('非法 NODE_ENV 抛错', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow();
  });

  it('非法 BOOTSTRAP_MODE 抛错', () => {
    expect(() => loadConfig({ BOOTSTRAP_MODE: 'full_history' })).toThrow();
  });

  it('非法 PUBLISH_MODE 抛错', () => {
    expect(() => loadConfig({ PUBLISH_MODE: 'auto' })).toThrow();
  });
});
