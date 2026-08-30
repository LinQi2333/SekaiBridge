import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../../src/db/database.js';
import type { Tweet } from '../../src/domain/tweet.js';
import { TweetRepository } from '../../src/repositories/tweet-repository.js';
import { WatchRepository } from '../../src/repositories/watch-repository.js';
import { SqliteMonitorService } from '../../src/services/monitor-service.js';
import type { ToasterTweetResponse } from '../../src/tweettoaster/types.js';
import { toasterResponse, toasterStatus } from '../helpers/tweettoaster-fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

/** 构造某账户的 timeline 响应。 */
function timelineOf(screenName: string, ids: string[]): ToasterTweetResponse {
  return toasterResponse({
    mode: 'timeline',
    query: { kind: 'profile', screenName, canonicalUrl: `https://x.com/${screenName}` },
    tweets: ids.map((id, index) =>
      toasterStatus({
        id,
        url: `https://x.com/${screenName}/status/${id}`,
        focal: index === 0,
        relation: 'timeline',
        author: { ...toasterStatus().author, screenName },
      }),
    ),
  });
}

interface MonitorFixture {
  watch: WatchRepository;
  tweets: TweetRepository;
  monitor: SqliteMonitorService;
  getTimeline: ReturnType<typeof vi.fn>;
}

function createMonitor(
  db: AppDatabase,
  options: {
    responder?: (screenName: string) => ToasterTweetResponse | Promise<ToasterTweetResponse>;
    onNewTweets?: (tweets: Tweet[]) => void;
    pollIntervalMs?: number;
    jitterMs?: number;
  } = {},
): MonitorFixture {
  const watch = new WatchRepository(db.db);
  const tweets = new TweetRepository(db.db);
  const responder = options.responder ?? (async (screenName) => timelineOf(screenName, ['100']));
  const getTimeline = vi.fn(async (screenName: string) => responder(screenName));
  const monitor = new SqliteMonitorService({
    watch,
    tweets,
    tweetToaster: { getTimeline },
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    jitterMs: options.jitterMs ?? 0,
    onNewTweets: options.onNewTweets,
  });
  return { watch, tweets, monitor, getTimeline };
}

let testDb: TestDb | null = null;

afterEach(() => {
  vi.useRealTimers();
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
});

describe('MonitorService（规格 §5 / §6 / §7 / §8）', () => {
  it('0 个监听账户：pollOnce 返回空，不调用数据源（Monitor Idle）', async () => {
    testDb = createTestDb();
    const f = createMonitor(testDb.app);
    const results = await f.monitor.pollOnce();
    expect(results).toEqual([]);
    expect(f.getTimeline).not.toHaveBeenCalled();
    expect(f.tweets.count({ filter: 'all' })).toBe(0);
  });

  it('1 个账户首次监听：bootstrap 只入库不通知（规格 §7）', async () => {
    testDb = createTestDb();
    const onNewTweets = vi.fn();
    const f = createMonitor(testDb.app, {
      responder: async () => timelineOf('foo', ['100', '200', '300']),
      onNewTweets,
    });
    f.watch.create('foo');

    const [result] = await f.monitor.pollOnce();
    expect(result).toMatchObject({
      screenName: 'foo',
      mode: 'bootstrap',
      timelineCount: 3,
      newTweets: [],
      duplicateCount: 0,
      error: null,
    });
    // 已有推文全部入库，标记 bootstrap 完成
    expect(f.tweets.count({ filter: 'all' })).toBe(3);
    expect(f.watch.findByScreenName('foo')?.bootstrapCompleted).toBe(true);
    // 不发送 QQ 通知
    expect(onNewTweets).not.toHaveBeenCalled();
  });

  it('bootstrap 后增量检测：只上报新推文，旧推文计为重复（规格 §8）', async () => {
    testDb = createTestDb();
    const seen: Tweet[][] = [];
    const f = createMonitor(testDb.app, {
      responder: async () => timelineOf('foo', ['100', '200']),
      onNewTweets: (tweets) => seen.push(tweets),
    });
    f.watch.create('foo');
    await f.monitor.pollOnce(); // bootstrap

    // 下一轮 timeline 多了一条新推文
    f.getTimeline.mockImplementation(async () => timelineOf('foo', ['100', '200', '400']));
    const [result] = await f.monitor.pollOnce();

    expect(result).toMatchObject({
      screenName: 'foo',
      mode: 'incremental',
      timelineCount: 3,
      newTweets: [{ xTweetId: '400' }],
      duplicateCount: 2,
      error: null,
    });
    expect(f.tweets.count({ filter: 'all' })).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((t) => t.xTweetId)).toEqual(['400']);
    // 新推文以 DETECTED 状态进入工作流
    expect(f.tweets.findByXId('400')?.workflowStatus).toBe('DETECTED');
  });

  it('N 个账户：一次性全部 bootstrap', async () => {
    testDb = createTestDb();
    const f = createMonitor(testDb.app, {
      // x_tweet_id 全局唯一，不同账户使用不同 id
      responder: async (screenName) => timelineOf(screenName, [`${screenName}100`, `${screenName}200`]),
    });
    f.watch.create('foo');
    f.watch.create('bar');
    f.watch.create('baz');

    const results = await f.monitor.pollOnce();
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.screenName).sort()).toEqual(['bar', 'baz', 'foo']);
    expect(results.every((r) => r.mode === 'bootstrap' && r.timelineCount === 2)).toBe(true);
    expect(f.tweets.count({ filter: 'all' })).toBe(6);
    expect(f.getTimeline).toHaveBeenCalledTimes(3);
  });

  it('x_tweet_id 去重：同一推文不重复入库（规格 §19）', async () => {
    testDb = createTestDb();
    const f = createMonitor(testDb.app, {
      responder: async () => timelineOf('foo', ['100', '200']),
    });
    f.watch.create('foo');

    await f.monitor.pollOnce();
    await f.monitor.pollOnce();
    await f.monitor.pollOnce();

    expect(f.tweets.count({ filter: 'all' })).toBe(2);
    expect(f.watch.findByScreenName('foo')?.bootstrapCompleted).toBe(true);
  });

  it('重启后已记录的推文仍去重（重启不丢任务）', async () => {
    testDb = createTestDb();
    const f = createMonitor(testDb.app, {
      responder: async () => timelineOf('foo', ['100', '200']),
    });
    f.watch.create('foo');
    await f.monitor.pollOnce();
    const idBefore = f.tweets.findByXId('100')?.id;

    // 模拟重启：关闭并重新打开数据库
    testDb.app.close();
    const reopened = new AppDatabase({ path: testDb.dbPath });
    const f2 = createMonitor(reopened, {
      responder: async () => timelineOf('foo', ['100', '200']),
    });
    expect(f2.watch.findByScreenName('foo')?.bootstrapCompleted).toBe(true);
    const [result] = await f2.monitor.pollOnce();

    expect(result.mode).toBe('incremental');
    expect(result.newTweets).toEqual([]);
    expect(result.duplicateCount).toBe(2);
    expect(f2.tweets.findByXId('100')?.id).toBe(idBefore);
    reopened.close();
    testDb = null;
  });

  it('禁用账户不参与轮询', async () => {
    testDb = createTestDb();
    const f = createMonitor(testDb.app);
    const account = f.watch.create('foo');
    f.watch.setEnabled(account.id, false);

    const results = await f.monitor.pollOnce();
    expect(results).toEqual([]);
    expect(f.getTimeline).not.toHaveBeenCalled();
  });

  it('错误韧性：一个账户失败不影响其他账户', async () => {
    testDb = createTestDb();
    const f = createMonitor(testDb.app, {
      responder: async (screenName) => {
        if (screenName === 'bad') throw new Error('TweetToaster 不可用');
        return timelineOf(screenName, ['100']);
      },
    });
    f.watch.create('bad');
    f.watch.create('good');

    const results = await f.monitor.pollOnce();
    const bad = results.find((r) => r.screenName === 'bad');
    const good = results.find((r) => r.screenName === 'good');
    expect(bad?.error).toContain('TweetToaster 不可用');
    expect(good?.mode).toBe('bootstrap');
    expect(good?.timelineCount).toBe(1);
    // 失败账户 bootstrap 未完成，成功账户已完成
    expect(f.watch.findByScreenName('bad')?.bootstrapCompleted).toBe(false);
    expect(f.watch.findByScreenName('good')?.bootstrapCompleted).toBe(true);
  });

  it('调度器：start 后按间隔自动轮询，stop 后停止（规格 §6）', async () => {
    vi.useFakeTimers();
    testDb = createTestDb();
    const f = createMonitor(testDb.app, {
      responder: async () => timelineOf('foo', ['100']),
      pollIntervalMs: 1000,
    });
    f.watch.create('foo');

    f.monitor.start();
    expect(f.monitor.isRunning()).toBe(true);

    // 首次调度 delay=0，立即执行一轮
    await vi.advanceTimersByTimeAsync(1);
    expect(f.getTimeline).toHaveBeenCalledTimes(1);
    expect(f.watch.findByScreenName('foo')?.bootstrapCompleted).toBe(true);

    // 间隔后再轮询
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.getTimeline).toHaveBeenCalledTimes(2);

    // stop 后不再轮询
    f.monitor.stop();
    expect(f.monitor.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.getTimeline).toHaveBeenCalledTimes(2);
  });

  it('调度器：0 个账户时保持空闲不请求', async () => {
    vi.useFakeTimers();
    testDb = createTestDb();
    const f = createMonitor(testDb.app, { pollIntervalMs: 1000 });
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.getTimeline).not.toHaveBeenCalled();
    f.monitor.stop();
  });
});
