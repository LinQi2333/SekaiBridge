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
  const fakeToaster = {
    health: vi.fn(async () => ({ status: 'ok', version: '2.0.0' })),
    getTimeline: vi.fn(async () => ({ mode: 'timeline', query: {}, tweets: [] })),
  };
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

  it('无监听账号：/列表 返回空结果（account=null），而非报错', async () => {
    const list = await api('/api/tweets?status=pending', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(list.status).toBe(200);
    expect(list.json.data).toMatchObject({ items: [], total: 0, account: null });
  });

  it('/列表 与 /查看（规格 §26 / §27，不含原文正文）', async () => {
    const repos = createRepositories(testDb!.app.db);
    // 需要一个默认账号（首个监听账号自动成为默认）
    const addAccount = await api('/api/watched-accounts', {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: { screen_name: 'example' },
    });
    expect(addAccount.status).toBe(200);
    const t1 = repos.tweets.create(tweetInput({ xTweetId: '100' }));
    repos.tweets.updateWorkflowStatus(t1.id, WorkflowStatus.TRANSLATED);
    const t2 = repos.tweets.create(tweetInput({ xTweetId: '200' }));

    const list = await api('/api/tweets?status=translated', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(list.status).toBe(200);
    expect((list.json.data as { total: number }).total).toBe(1);
    expect((list.json.data as { account: string }).account).toBe('example');

    const view = await api(`/api/tweets/${t2.id}`, { token: TOKEN, user: MEMBER, group: GROUP });
    expect(view.status).toBe(200);
    const viewData = view.json.data as { tweet: { id: number; seq: number }; format: { view: string } };
    expect(viewData.tweet.id).toBe(t2.id);
    expect(viewData.format.view).toContain(`#${viewData.tweet.seq}`);
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

  it('话题库：成员可查看；管理员增删（规格 §31）', async () => {
    const repos = createRepositories(testDb!.app.db);

    // 管理员添加（名称省略时默认取别名）
    const add = await api('/api/topics', {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: { bili_topic_id: '23456', alias: 'hololive' },
    });
    expect(add.status).toBe(200);
    expect((add.json.data as { topic: { alias: string; biliTopicId: string } }).topic).toMatchObject({
      alias: 'hololive',
      biliTopicId: '23456',
    });

    // 成员添加 → 403
    const memberAdd = await api('/api/topics', {
      method: 'POST',
      token: TOKEN,
      user: MEMBER,
      group: GROUP,
      body: { bili_topic_id: '34567', alias: 'live' },
    });
    expect(memberAdd.status).toBe(403);

    // 重复别名 → 409
    const dup = await api('/api/topics', {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: { bili_topic_id: '99999', alias: 'hololive' },
    });
    expect(dup.status).toBe(409);

    // 重复 B站话题号 → 409
    const dupId = await api('/api/topics', {
      method: 'POST',
      token: TOKEN,
      user: ADMIN,
      group: GROUP,
      body: { bili_topic_id: '23456', alias: 'another' },
    });
    expect(dupId.status).toBe(409);

    // 成员查看
    const list = await api('/api/topics', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(list.status).toBe(200);
    expect((list.json.data as { topics: { alias: string }[] }).topics.map((t) => t.alias)).toEqual(['hololive']);

    // 管理员删除
    const del = await api('/api/topics/hololive', { method: 'DELETE', token: TOKEN, user: ADMIN, group: GROUP });
    expect(del.status).toBe(200);
    const after = await api('/api/topics', { token: TOKEN, user: MEMBER, group: GROUP });
    expect((after.json.data as { topics: unknown[] }).topics).toHaveLength(0);

    // 成员删除 → 403
    const memberDel = await api('/api/topics/ghost', { method: 'DELETE', token: TOKEN, user: MEMBER, group: GROUP });
    expect(memberDel.status).toBe(403);
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

  it('默认账号：PATCH default 切换，列表未指定账号用默认，指定 account 用指定', async () => {
    // 添加两个账号（首个 foo 自动默认）
    const addFoo = await api('/api/watched-accounts', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { screen_name: 'foo' },
    });
    expect(addFoo.status).toBe(200);
    const addBar = await api('/api/watched-accounts', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { screen_name: 'bar' },
    });
    expect(addBar.status).toBe(200);

    const repos = createRepositories(testDb!.app.db);
    repos.tweets.create(tweetInput({ xTweetId: '100', authorScreenName: 'foo' }));
    repos.tweets.updateWorkflowStatus(
      repos.tweets.findByXId('100')!.id, WorkflowStatus.TRANSLATED,
    );
    repos.tweets.create(tweetInput({ xTweetId: '200', authorScreenName: 'bar' }));
    repos.tweets.updateWorkflowStatus(
      repos.tweets.findByXId('200')!.id, WorkflowStatus.TRANSLATED,
    );

    // 未指定账号 → 默认账号 foo
    const list = await api('/api/tweets?status=translated', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(list.status).toBe(200);
    const data = list.json.data as { account: string; total: number };
    expect(data.account).toBe('foo');
    expect(data.total).toBe(1);

    // 指定 account=bar
    const listBar = await api('/api/tweets?status=translated&account=bar', {
      token: TOKEN, user: MEMBER, group: GROUP,
    });
    expect((listBar.json.data as { account: string; total: number }).account).toBe('bar');
    expect((listBar.json.data as { total: number }).total).toBe(1);

    // 切换默认账号
    const setDefault = await api('/api/watched-accounts/bar', {
      method: 'PATCH', token: TOKEN, user: ADMIN, group: GROUP, body: { default: true },
    });
    expect(setDefault.status).toBe(200);
    const list2 = await api('/api/tweets?status=translated', { token: TOKEN, user: MEMBER, group: GROUP });
    expect((list2.json.data as { account: string }).account).toBe('bar');

    // 指定未监听账号 → 404
    const bad = await api('/api/tweets?account=ghost', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(bad.status).toBe(404);
  });

  it('seq 解析：账号内编号按默认/指定账号解析（/api/tweets/resolve）', async () => {
    await api('/api/watched-accounts', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { screen_name: 'foo' },
    });
    await api('/api/watched-accounts', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { screen_name: 'bar' },
    });
    const repos = createRepositories(testDb!.app.db);
    const t1 = repos.tweets.create(tweetInput({ xTweetId: '100', authorScreenName: 'foo' }));
    repos.tweets.create(tweetInput({ xTweetId: '200', authorScreenName: 'foo' }));
    repos.tweets.create(tweetInput({ xTweetId: '300', authorScreenName: 'bar' }));

    // 默认账号 foo 的 #2
    const r1 = await api('/api/tweets/resolve?seq=2', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(r1.status).toBe(200);
    expect((r1.json.data as { tweet: { id: number; seq: number } }).tweet.id).toBe(
      repos.tweets.findByXId('200')!.id,
    );

    // 指定账号 bar 的 #1
    const r2 = await api('/api/tweets/resolve?seq=1&account=bar', {
      token: TOKEN, user: MEMBER, group: GROUP,
    });
    expect((r2.json.data as { tweet: { xTweetId: string } }).tweet.xTweetId).toBe('300');

    // 不存在的编号 → 404
    const r3 = await api('/api/tweets/resolve?seq=99', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(r3.status).toBe(404);

    // 无任何监听账号时 seq 解析报 NO_WATCHED_ACCOUNTS（删光全部账号）
    await api('/api/watched-accounts/foo', { method: 'DELETE', token: TOKEN, user: ADMIN, group: GROUP });
    await api('/api/watched-accounts/bar', { method: 'DELETE', token: TOKEN, user: ADMIN, group: GROUP });
    const r4 = await api('/api/tweets/resolve?seq=1', { token: TOKEN, user: MEMBER, group: GROUP });
    expect(r4.status).toBe(400);
    expect((r4.json.error as { code: string }).code).toBe('NO_WATCHED_ACCOUNTS');
    void t1;
  });

  it('删除监听：连带清空该账号历史推文（API 级）', async () => {
    await api('/api/watched-accounts', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { screen_name: 'foo' },
    });
    await api('/api/watched-accounts', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { screen_name: 'bar' },
    });
    const repos = createRepositories(testDb!.app.db);
    repos.tweets.create(tweetInput({ xTweetId: '100', authorScreenName: 'foo' }));
    repos.tweets.create(tweetInput({ xTweetId: '200', authorScreenName: 'foo' }));
    repos.tweets.create(tweetInput({ xTweetId: '300', authorScreenName: 'bar' }));

    const del = await api('/api/watched-accounts/foo', {
      method: 'DELETE', token: TOKEN, user: ADMIN, group: GROUP,
    });
    expect(del.status).toBe(200);
    expect((del.json.data as { removed: boolean; tweetsDeleted: number })).toMatchObject({
      removed: true,
      tweetsDeleted: 2,
    });
    expect(repos.tweets.count({ filter: 'all' })).toBe(1);
    expect(repos.tweets.findByXId('300')?.authorScreenName).toBe('bar');
  });

  it('立即刷新：POST /api/refresh（管理员），指定账号/全部', async () => {
    const addFoo = await api('/api/watched-accounts', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { screen_name: 'foo' },
    });
    expect(addFoo.status).toBe(200);
    const addBar = await api('/api/watched-accounts', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { screen_name: 'bar' },
    });
    expect(addBar.status).toBe(200);

    // 成员 403
    const forbidden = await api('/api/refresh', {
      method: 'POST', token: TOKEN, user: MEMBER, group: GROUP, body: {},
    });
    expect(forbidden.status).toBe(403);

    // 管理员刷新全部
    const all = await api('/api/refresh', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: {},
    });
    expect(all.status).toBe(200);
    const results = (all.json.data as { results: { screenName: string; mode: string }[] }).results;
    expect(results.map((r) => r.screenName).sort()).toEqual(['bar', 'foo']);
    expect(results.every((r) => r.mode === 'bootstrap')).toBe(true);

    // 指定账号（大小写不敏感：Bar → bar）
    const single = await api('/api/refresh', {
      method: 'POST', token: TOKEN, user: ADMIN, group: GROUP, body: { account: 'Bar' },
    });
    expect(
      (single.json.data as { results: { screenName: string }[] }).results.map((r) => r.screenName),
    ).toEqual(['bar']);
  });
});
