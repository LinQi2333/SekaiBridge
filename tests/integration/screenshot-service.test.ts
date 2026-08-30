import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TweetRepository } from '../../src/repositories/tweet-repository.js';
import { DefaultScreenshotService } from '../../src/services/screenshot-service.js';
import { NotFoundError } from '../../src/services/errors.js';
import { toasterResponse } from '../helpers/tweettoaster-fixtures.js';
import { tweetInput } from '../helpers/fixtures.js';
import { closeTestDb, createTestDb, type TestDb } from '../helpers/test-db.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let testDb: TestDb | null = null;
let tmpDir = '';

afterEach(() => {
  if (testDb) {
    closeTestDb(testDb);
    testDb = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('DefaultScreenshotService（规格 §15 / §47 / §65）', () => {
  it('生成原推截图并保存到 cache/screenshots/<tweet-id>.png', async () => {
    testDb = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-shot-'));
    const repo = new TweetRepository(testDb.app.db);
    const tweet = repo.create(tweetInput());

    const tweetToaster = {
      getTweet: vi.fn(async () => toasterResponse()),
      render: vi.fn(async () => 'http://tweettoaster:8082/cache/123.png'),
    };
    const fetchImpl = vi.fn(async () =>
      new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const service = new DefaultScreenshotService({
      tweets: repo,
      tweetToaster,
      cacheDir: path.join(tmpDir, 'screenshots'),
      fetchImpl,
    });

    const filePath = await service.render(tweet.id);
    expect(filePath).toBe(path.join(tmpDir, 'screenshots', `${tweet.id}.png`));
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath)).toEqual(PNG);
  });

  it('render 请求为 original-only（空模板、无 Logo、选中焦点推文）', async () => {
    testDb = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-shot-'));
    const repo = new TweetRepository(testDb.app.db);
    const tweet = repo.create(tweetInput({ tweetUrl: 'https://x.com/example/status/100' }));

    const tweetToaster = {
      getTweet: vi.fn(async () => toasterResponse()),
      render: vi.fn(async () => 'http://tweettoaster:8082/cache/x.png'),
    };
    const fetchImpl = vi.fn(async () =>
      new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const service = new DefaultScreenshotService({
      tweets: repo,
      tweetToaster,
      cacheDir: path.join(tmpDir, 'screenshots'),
      fetchImpl,
    });

    await service.render(tweet.id);
    const request = tweetToaster.render.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      tweet: 'https://x.com/example/status/100',
      translate: '',
      template: '',
      logo: 'none',
      noLikes: true,
      selection: [{ id: '1890000000000000000' }],
    });
    expect(tweetToaster.getTweet).toHaveBeenCalledWith(tweet.tweetUrl);
  });

  it('推文不存在抛 NotFoundError', async () => {
    testDb = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqb-shot-'));
    const repo = new TweetRepository(testDb.app.db);
    const service = new DefaultScreenshotService({
      tweets: repo,
      tweetToaster: { getTweet: vi.fn(), render: vi.fn() },
      cacheDir: path.join(tmpDir, 'screenshots'),
    });
    await expect(service.render(9999)).rejects.toBeInstanceOf(NotFoundError);
  });
});
