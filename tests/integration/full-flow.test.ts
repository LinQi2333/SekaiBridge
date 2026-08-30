import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config/config.js';
import { WorkflowStatus } from '../../src/domain/workflow.js';
import { createRepositories, createServices, type Repositories } from '../../src/services/index.js';
import type { ToasterMedia, ToasterStatus, ToasterTweetResponse } from '../../src/tweettoaster/types.js';
import type { TweetToasterClient } from '../../src/tweettoaster/client.js';
import { toasterResponse, toasterStatus } from '../helpers/tweettoaster-fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

const ADMIN = '20001';
const MEMBER = '30001';
const GROUP = '10001';
const TOKEN = 'phase9-token';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

let testDb: TestDb | null = null;
let tmpDir = '';
let server: Server | null = null;
let baseUrl = '';

function status(screenName: string, id: string, index: number, media: ToasterMedia[] = []): ToasterStatus {
  return toasterStatus({
    id,
    url: `https://x.com/${screenName}/status/${id}`,
    focal: index === 0,
    relation: 'timeline',
    author: { ...toasterStatus().author, screenName },
    media,
  });
}

/** 构造 timeline 响应：首次 bootstrap（first），之后增量（laterIds，新推文带指定媒体）。 */
function timelineSequence(screenName: string, first: string[], laterIds: string[], newMedia: ToasterMedia[]) {
  const make = (ids: string[], mediaForNew: boolean): ToasterTweetResponse =>
    toasterResponse({
      mode: 'timeline',
      tweets: ids.map((id, index) =>
        status(screenName, id, index, mediaForNew && index === ids.length - 1 ? newMedia : []),
      ),
    });
  return vi
    .fn()
    .mockResolvedValueOnce(make(first, false))
    .mockImplementation(async () => make(laterIds, true));
}

interface FlowEnv {
  repos: Repositories;
  tweetToaster: TweetToasterClient;
  imageUploader: { uploadImage: ReturnType<typeof vi.fn> };
  dynamicPublisher: { publishDynamic: ReturnType<typeof vi.fn> };
  fetchImpl: ReturnType<typeof vi.fn>;
}

/** 全链路 Mock 环境（规格 §55：Mock TweetToaster / Mock Bilibili / Mock 媒体下载）。 */
function setupFlow(newMedia: ToasterMedia[]): FlowEnv & { services: ReturnType<typeof createServices> } {
  testDb = createTestDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-flow-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: testDb.dbPath,
    CACHE_ROOT: tmpDir,
    QQ_GROUP_IDS: GROUP,
    QQ_ADMIN_IDS: ADMIN,
    API_TOKEN: TOKEN,
  });
  const repos = createRepositories(testDb.app.db);

  const tweetToaster = {
    getTimeline: timelineSequence('foo', ['100', '200'], ['100', '200', '300'], newMedia),
    getTweet: vi.fn(async () => toasterResponse()),
    render: vi.fn(async () => 'http://tweettoaster:8082/cache/shot.png'),
    health: vi.fn(async () => ({ status: 'ok', version: '2.0.0' })),
  } as unknown as TweetToasterClient;

  // 媒体下载 mock：截图 PNG + Twitter 原图 JPEG；视频本体（.mp4）必然 404
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.startsWith('http://tweettoaster:8082/cache/')) {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url.startsWith('https://pbs.twimg.com/')) {
      return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('not found', { status: 404 });
  });

  const imageUploader = {
    uploadImage: vi.fn(async (_buf: Buffer, filename: string) => `https://i0.hdslb.com/bfs/article/${filename}`),
  };
  const dynamicPublisher = {
    publishDynamic: vi.fn(async () => '90001'),
  };

  const services = createServices(repos, {
    config,
    tweetToaster,
    bilibili: { imageUploader, dynamicPublisher },
    fetchImpl,
  });
  return { repos, tweetToaster, imageUploader, dynamicPublisher, fetchImpl, services };
}

async function startApi(env: FlowEnv): Promise<void> {
  server = createApiServer({
    services: env.services,
    config: loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: testDb!.dbPath,
      CACHE_ROOT: tmpDir,
      QQ_GROUP_IDS: GROUP,
      QQ_ADMIN_IDS: ADMIN,
      API_TOKEN: TOKEN,
    }),
    notifications: env.repos.notifications,
    messageDedupe: env.repos.messageDedupe,
    tweetToaster: env.tweetToaster,
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server?.address();
  if (typeof address === 'object' && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
}

async function api(pathname: string, options: { method?: string; token?: string; user?: string; group?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers['x-api-token'] = options.token;
  if (options.user) headers['x-qq-user'] = options.user;
  if (options.group) headers['x-qq-group'] = options.group;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('Phase 9 完整集成（规格 §62 Phase 9 / §55 Mock）', () => {
  it('图片推文全链路：监听 → 截图 → Mock QQ 通知 → 翻译 → 话题 → 发布 → Mock Bilibili', async () => {
    const env = setupFlow([
      { type: 'photo', url: 'https://pbs.twimg.com/media/photo-a.jpg', width: 1000, height: 800, alt: '' },
    ]);
    await startApi(env);
    const { repos, services, imageUploader, dynamicPublisher } = env;

    // 1) 监听账户 + bootstrap：只入库、不通知（§7）
    services.watch.add('foo');
    const boot = await services.monitor.pollOnce();
    expect(boot[0]?.mode).toBe('bootstrap');
    expect(repos.notifications.listPending()).toHaveLength(0);
    expect(repos.tweets.count({ filter: 'all' })).toBe(2);

    // 2) 增量：新推文 #300 自动完成 截图 → SCREENSHOT_READY → 媒体缓存 → 通知
    const inc = await services.monitor.pollOnce();
    const newTweet = inc[0]?.newTweets[0];
    // 处理管线已同步完成（pollOnce await onNewTweets），从 DB 读取最新状态
    const tweet = repos.tweets.findById(newTweet!.id);
    expect(tweet?.workflowStatus).toBe(WorkflowStatus.SCREENSHOT_READY);
    const shotPath = tweet?.screenshotPath;
    expect(shotPath).toBe(path.join(tmpDir, 'screenshots', String(tweet?.id)) + '.png');
    expect(fs.existsSync(shotPath!)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'twitter-photos', String(tweet?.id), '0.jpg'))).toBe(true);

    // 3) Mock QQ：拉取通知并 ack（§42）
    const list = await api('/api/notifications', { token: TOKEN });
    const notifications = (list.json.data as { notifications: { id: number; text: string; screenshotPath: string | null }[] }).notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.text).toContain('【新推文 #3】');
    expect(notifications[0]?.text).toContain('账号：@foo');
    expect(notifications[0]?.text).toContain('原推：');
    expect(notifications[0]?.text).not.toContain('頑張る'); // §51 不含原文
    expect(notifications[0]?.screenshotPath).toBe(shotPath);
    const ack = await api(`/api/notifications/${notifications[0]!.id}/ack`, { method: 'POST', token: TOKEN });
    expect((ack.json.data as { acked: boolean }).acked).toBe(true);

    // 4) 翻译（成员，§28）：保留 emoji 与换行
    const translation = await api(`/api/tweets/${tweet!.id}/translation`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { text: '今天也辛苦啦～！🌸\n\n第二行', qq_user_id: MEMBER },
    });
    expect(translation.status).toBe(200);

    // 5) 话题（成员，§32）
    repos.topics.create({ alias: 'hololive', biliTopicId: '23456', name: 'hololive' });
    const topic = await api(`/api/tweets/${tweet!.id}/topic`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { alias: 'hololive' },
    });
    expect(topic.status).toBe(200);

    // 6) 发布（管理员，§33）→ Mock Bilibili
    const publish = await api(`/api/tweets/${tweet!.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: {},
    });
    expect(publish.status).toBe(200);
    const publishData = publish.json.data as { result: { record: { biliDynamicId: string } } };
    expect(publishData.result.record.biliDynamicId).toBe('90001');
    expect(imageUploader.uploadImage).toHaveBeenCalledTimes(1);
    expect(dynamicPublisher.publishDynamic).toHaveBeenCalledWith({
      text: '今天也辛苦啦～！🌸\n\n第二行',
      pics: ['https://i0.hdslb.com/bfs/article/photo-a.jpg'],
      topicId: '23456',
    });

    // 7) 幂等：再次发布不调用 Bilibili（§38）
    const again = await api(`/api/tweets/${tweet!.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: {},
    });
    expect((again.json.data as { result: { published: boolean } }).result.published).toBe(false);
    expect(imageUploader.uploadImage).toHaveBeenCalledTimes(1);

    // 最终状态
    const final = repos.tweets.findById(tweet!.id);
    expect(final?.workflowStatus).toBe(WorkflowStatus.PUBLISHED);
    expect(repos.publish.findSuccessfulByTweet(tweet!.id)?.biliDynamicId).toBe('90001');
  });

  it('视频推文全链路：通知含视频提示、只缓存封面、Bilibili 纯文本动态（§18 / §22 / §52 / §53）', async () => {
    const env = setupFlow([
      { type: 'video', url: 'https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/cover.jpg', width: 640, height: 360, alt: '' },
    ]);
    await startApi(env);
    const { repos, services, imageUploader, dynamicPublisher, fetchImpl } = env;

    services.watch.add('foo');
    await services.monitor.pollOnce(); // bootstrap

    const inc = await services.monitor.pollOnce();
    const tweet = repos.tweets.findById(inc[0]!.newTweets[0]!.id);
    expect(tweet?.workflowStatus).toBe(WorkflowStatus.SCREENSHOT_READY);

    // 通知（§52）：含"包含视频"提示；封面已缓存
    const pending = repos.notifications.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toContain('⚠️ 此推文包含视频。');
    expect(pending[0]?.text).toContain('视频本体不会下载或转载');
    expect(pending[0]?.text).not.toContain('頑張る');
    const coverPath = pending[0]?.videoThumbnails[0];
    expect(coverPath).toBe(path.join(tmpDir, 'video-thumbnails', String(tweet?.id), '0.jpg'));
    expect(fs.existsSync(coverPath!)).toBe(true);

    // 视频本体从未下载（§52）：没有任何 .mp4 请求
    const requested = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(requested.some((u) => u.includes('.mp4'))).toBe(false);

    // 翻译 → 发布：视频-only → 纯文本动态（§22 / §53），图片上传 0 次
    await api(`/api/tweets/${tweet!.id}/translation`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { text: '纯文本译文', qq_user_id: MEMBER },
    });
    const publish = await api(`/api/tweets/${tweet!.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: {},
    });
    expect(publish.status).toBe(200);
    expect(imageUploader.uploadImage).toHaveBeenCalledTimes(0);
    expect(dynamicPublisher.publishDynamic).toHaveBeenCalledWith({
      text: '纯文本译文',
      pics: [],
      topicId: null,
    });
    // 视频封面不上传 Bilibili（§53）：twitter-photos 目录根本不会创建
    expect(fs.existsSync(path.join(tmpDir, 'twitter-photos', String(tweet?.id)))).toBe(false);
  });
});
