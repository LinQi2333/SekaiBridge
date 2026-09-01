import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishResult, PublishService } from '../../src/services/publish-service.js';
import { createApiServer } from '../../src/api/server.js';
import { loadConfig, type AppConfig } from '../../src/config/config.js';
import { WorkflowStatus } from '../../src/domain/workflow.js';
import { createRepositories, createServices } from '../../src/services/index.js';
import type { TweetToasterClient } from '../../src/tweettoaster/client.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

const ADMIN = '20001';
const MEMBER = '30001';
const GROUP = '10001';
const TOKEN = 'test-token';

let testDb: TestDb | null = null;
let tmpDir = '';
let server: Server | null = null;
let baseUrl = '';
let mockPublish: { publish: ReturnType<typeof vi.fn>; isPublished: ReturnType<typeof vi.fn> };

interface ApiOptions {
  method?: string;
  token?: string;
  user?: string;
  group?: string;
  role?: string;
  body?: unknown;
}

async function api(pathname: string, options: ApiOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers['x-api-token'] = options.token;
  if (options.user) headers['x-qq-user'] = options.user;
  if (options.group) headers['x-qq-group'] = options.group;
  if (options.role) headers['x-qq-role'] = options.role;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function startServer(overrides: Partial<AppConfig> = {}): Promise<void> {
  testDb = createTestDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-api-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: testDb.dbPath,
    CACHE_ROOT: tmpDir,
    QQ_GROUP_IDS: GROUP,
    QQ_ADMIN_IDS: ADMIN,
    API_TOKEN: TOKEN,
    ...overrides,
  });
  const repos = createRepositories(testDb.app.db);
  const fakeToaster = { health: vi.fn(async () => ({ status: 'ok', version: '2.0.0' })) };
  mockPublish = {
    publish: vi.fn(async (tweetId: number, topicAlias?: string): Promise<PublishResult> => ({
      published: true,
      record: { id: 1, tweetId, translationId: null, biliDynamicId: '888888', biliTopicId: topicAlias ?? null, status: 'SUCCESS', attemptCount: 1, lastError: null, createdAt: '', publishedAt: '' },
    })),
    isPublished: vi.fn(() => false),
  };
  const services = createServices(repos, {
    config,
    tweetToaster: fakeToaster as unknown as TweetToasterClient,
    publish: mockPublish as unknown as PublishService,
  });
  server = createApiServer({
    services,
    config,
    notifications: repos.notifications,
    messageDedupe: repos.messageDedupe,
    tweetToaster: fakeToaster as unknown as TweetToasterClient,
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server?.address();
  if (typeof address === 'object' && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
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

describe('HTTP API（NoneBot2 方案，规格 §2.2 / §41 / §57）', () => {
  beforeEach(async () => {
    await startServer();
  });

  it('health（§57）', async () => {
    const res = await api('/api/health');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'ok', database: 'ok', tweettoaster: 'ok', qq: 'external' });
  });

  it('鉴权：token 错误 401', async () => {
    const res = await api('/api/watched-accounts', { token: 'wrong', user: ADMIN, group: GROUP });
    expect(res.status).toBe(401);
  });

  it('监听管理：普通成员 403，管理员可增删改查（规格 §25 / §41）', async () => {
    const forbidden = await api('/api/watched-accounts', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(forbidden.status).toBe(403);

    const add = await api('/api/watched-accounts', {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: { screen_name: '@FooBar' },
    });
    expect(add.status).toBe(200);
    expect((add.json.data as { account: { screenName: string } }).account.screenName).toBe('foobar');

    const list = await api('/api/watched-accounts', { token: TOKEN, user: ADMIN, group: GROUP });
    expect((list.json.data as { accounts: unknown[] }).accounts).toHaveLength(1);

    const disable = await api('/api/watched-accounts/foobar', {
      method: 'PATCH',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: { enabled: false },
    });
    expect((disable.json.data as { account: { enabled: boolean } }).account.enabled).toBe(false);

    const remove = await api('/api/watched-accounts/foobar', {
      method: 'DELETE',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
    });
    expect(remove.status).toBe(200);
  });

  it('群白名单：非允许群 403', async () => {
    const res = await api('/api/tweets', { token: TOKEN, user: MEMBER, group: '99999' });
    expect(res.status).toBe(403);
  });

  it('/列表 与 /查看（规格 §26 / §27，不含原文正文）', async () => {
    const repos = createRepositories(testDb!.app.db);
    const t1 = repos.tweets.create(tweetInput({ xTweetId: '100' }));
    repos.tweets.updateWorkflowStatus(t1.id, WorkflowStatus.TRANSLATED);
    const t2 = repos.tweets.create(tweetInput({ xTweetId: '200' }));

    const list = await api('/api/tweets?status=translated', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(list.status).toBe(200);
    expect((list.json.data as { total: number }).total).toBe(1);

    const view = await api(`/api/tweets/${t2.id}`, { token: TOKEN, user: MEMBER, group: GROUP });
    expect(view.status).toBe(200);
    const viewData = view.json.data as { tweet: { id: number }; format: { view: string } };
    expect(viewData.tweet.id).toBe(t2.id);
    expect(viewData.format.view).toContain(`#${t2.id}`);
    expect(viewData.format.view).toContain('https://x.com/example/status/');
    expect(viewData.format.view).not.toContain('頑張る'); // 原文正文不出现

    const missing = await api('/api/tweets?ids=1,9999,2', { token: TOKEN, user: MEMBER, group: GROUP });
    expect((missing.json.data as { missing: number[] }).missing).toEqual([9999]);
  });

  it('翻译提交：保留 emoji / 换行，版本递增（规格 §28 / §49）', async () => {
    const repos = createRepositories(testDb!.app.db);
    const tweet = repos.tweets.create(tweetInput({ xTweetId: '100' }));

    const first = await api(`/api/tweets/${tweet.id}/translation`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { text: '今天也辛苦啦～！🌸\n\n晚上还有直播！', qq_user_id: MEMBER },
    });
    expect(first.status).toBe(200);
    const result1 = first.json.data as { result: { translation: { version: number; text: string }; workflowStatus: string } };
    expect(result1.result.translation.version).toBe(1);
    expect(result1.result.translation.text).toBe('今天也辛苦啦～！🌸\n\n晚上还有直播！');
    expect(result1.result.workflowStatus).toBe('TRANSLATED');

    const second = await api(`/api/tweets/${tweet.id}/translation`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { text: 'v2', qq_user_id: MEMBER },
    });
    const result2 = second.json.data as { result: { translation: { version: number } } };
    expect(result2.result.translation.version).toBe(2);
  });

  it('话题设置与取消（规格 §32）', async () => {
    const repos = createRepositories(testDb!.app.db);
    const tweet = repos.tweets.create(tweetInput({ xTweetId: '100' }));
    repos.topics.create({ alias: 'hololive', biliTopicId: '23456', name: 'hololive' });

    const set = await api(`/api/tweets/${tweet.id}/topic`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { alias: 'hololive' },
    });
    expect((set.json.data as { tweet: { topicAlias: string | null } }).tweet.topicAlias).toBe('hololive');

    const unset = await api(`/api/tweets/${tweet.id}/topic`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { alias: null },
    });
    expect((unset.json.data as { tweet: { topicAlias: string | null } }).tweet.topicAlias).toBeNull();
  });

  it('发布：仅管理员，调用 PublishService（幂等由服务保证）', async () => {
    const repos = createRepositories(testDb!.app.db);
    const tweet = repos.tweets.create(tweetInput({ xTweetId: '100' }));
    repos.tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.TRANSLATED);

    const member = await api(`/api/tweets/${tweet.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: {},
    });
    expect(member.status).toBe(403);
    expect(mockPublish.publish).not.toHaveBeenCalled();

    const admin = await api(`/api/tweets/${tweet.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: { topic_alias: 'hololive' },
    });
    expect(admin.status).toBe(200);
    expect(mockPublish.publish).toHaveBeenCalledWith(tweet.id, 'hololive');
  });

  it('发布：群主/群管理员（X-QQ-Role）自动视为管理员，普通成员仍 403', async () => {
    const repos = createRepositories(testDb!.app.db);
    const tweet = repos.tweets.create(tweetInput({ xTweetId: '100' }));
    repos.tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.TRANSLATED);

    // 普通成员带 role=member / 不带 role → 403
    const plainMember = await api(`/api/tweets/${tweet.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      role: 'member',
      body: {},
    });
    expect(plainMember.status).toBe(403);

    const noRole = await api(`/api/tweets/${tweet.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: {},
    });
    expect(noRole.status).toBe(403);
    expect(mockPublish.publish).not.toHaveBeenCalled();

    // 群管理员 → 200
    const groupAdmin = await api(`/api/tweets/${tweet.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      role: 'admin',
      body: {},
    });
    expect(groupAdmin.status).toBe(200);
    expect(mockPublish.publish).toHaveBeenCalledTimes(1);

    // 群主 → 200
    const owner = await api(`/api/tweets/${tweet.id}/publish`, {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      role: 'owner',
      body: {},
    });
    expect(owner.status).toBe(200);
    expect(mockPublish.publish).toHaveBeenCalledTimes(2);
  });

  it('重试：调用 PublishService（规格 §39）', async () => {
    const repos = createRepositories(testDb!.app.db);
    const tweet = repos.tweets.create(tweetInput({ xTweetId: '100' }));
    repos.tweets.updateWorkflowStatus(tweet.id, WorkflowStatus.PUBLISH_FAILED);

    const res = await api(`/api/tweets/${tweet.id}/retry`, {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
    });
    expect(res.status).toBe(200);
    expect(mockPublish.publish).toHaveBeenCalledTimes(1);
    expect(mockPublish.publish.mock.calls[0]?.[0]).toBe(tweet.id);
  });

  it('通知队列：拉取 pending 与 ack（§42）', async () => {
    const repos = createRepositories(testDb!.app.db);
    const tweet = repos.tweets.create(tweetInput({ xTweetId: '100' }));
    const n = repos.notifications.create({
      tweetId: tweet.id,
      text: '【新推文 #1】通知文本',
      screenshotPath: 'cache/screenshots/1.png',
      videoThumbnails: [],
    });

    const list = await api('/api/notifications', { token: TOKEN });
    expect(list.status).toBe(200);
    const notifications = (list.json.data as { notifications: { id: number; text: string }[] }).notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.text).toBe('【新推文 #1】通知文本');

    const ack = await api(`/api/notifications/${n.id}/ack`, { method: 'POST', token: TOKEN });
    expect((ack.json.data as { acked: boolean }).acked).toBe(true);
    const after = (await api('/api/notifications', { token: TOKEN })).json.data as {
      notifications: unknown[];
    };
    expect(after.notifications).toHaveLength(0);
  });

  it('QQ 消息去重（规格 §43）', async () => {
    const first = await api('/api/messages/dedupe', {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { message_id: 'msg-1' },
    });
    expect((first.json.data as { duplicate: boolean }).duplicate).toBe(false);
    const second = await api('/api/messages/dedupe', {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { message_id: 'msg-1' },
    });
    expect((second.json.data as { duplicate: boolean }).duplicate).toBe(true);
  });

  it('未知接口 404，坏 JSON 400', async () => {
    expect((await api('/api/nope', { token: TOKEN })).status).toBe(404);
    const res = await fetch(`${baseUrl}/api/tweets/1/translation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-token': TOKEN, 'x-qq-user': MEMBER, 'x-qq-group': GROUP },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
  });
});
