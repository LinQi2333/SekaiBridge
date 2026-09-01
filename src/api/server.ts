import http from 'node:http';
import path from 'node:path';
import { BilibiliApiError, BilibiliAuthError, BilibiliNetworkError } from '../bilibili/errors.js';
import type { AppConfig } from '../config/config.js';
import { formatTweetView } from '../qq/format.js';
import { checkPermission, type QqIdentity, type QqPermission } from '../qq/permission.js';
import { MessageDedupeRepository } from '../repositories/message-dedupe-repository.js';
import { NotificationRepository } from '../repositories/notification-repository.js';
import type { AppServices } from '../services/index.js';
import {
  AlreadyExistsError,
  IllegalTransitionError,
  NotImplementedError,
  NotFoundError,
  ValidationError,
} from '../services/errors.js';
import type { TweetToasterClient } from '../tweettoaster/client.js';

/**
 * 内部 HTTP API（规格 §2.2 / §57）。
 * NoneBot2（Python，连 NapCat）与未来 Web 通过这里调用同一套 Application Services。
 * 本层只做：鉴权、权限、参数解析、结果格式化；业务全部在 services。
 */

export interface ApiServerOptions {
  services: AppServices;
  config: AppConfig;
  notifications: NotificationRepository;
  messageDedupe: MessageDedupeRepository;
  tweetToaster: Pick<TweetToasterClient, 'health'>;
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY = 1024 * 1024;

/** 媒体路径解析：DB 存相对 cacheRoot 路径（可移植），返回时按当前机器转绝对路径。 */
function resolveMediaPath(p: string | null, cacheRoot: string): string | null {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.resolve(cacheRoot, p);
}

function resolveTweetMediaPaths(t: Record<string, unknown>, cacheRoot: string): void {
  if (typeof t.screenshotPath === 'string') {
    t.screenshotPath = resolveMediaPath(t.screenshotPath, cacheRoot);
  }
}

function resolveNotificationMediaPaths(n: Record<string, unknown>, cacheRoot: string): void {
  if (typeof n.screenshotPath === 'string') {
    n.screenshotPath = resolveMediaPath(n.screenshotPath, cacheRoot);
  }
  if (Array.isArray(n.videoThumbnails)) {
    n.videoThumbnails = n.videoThumbnails.map((v) =>
      typeof v === 'string' ? resolveMediaPath(v, cacheRoot) : v,
    );
  }
}

const LIST_FILTERS = ['pending', 'translated', 'published', 'failed', 'all'] as const;

function parseListFilter(value: string | null): (typeof LIST_FILTERS)[number] {
  const filter = (value ?? 'pending') as string;
  if (!(LIST_FILTERS as readonly string[]).includes(filter)) {
    throw new ApiError(400, 'BAD_PARAM', `无效的 status: ${filter}（可选 ${LIST_FILTERS.join('/')}）`);
  }
  return filter as (typeof LIST_FILTERS)[number];
}

export function createApiServer(options: ApiServerOptions): http.Server {
  const { services, config, notifications, messageDedupe } = options;

  function checkToken(req: http.IncomingMessage): void {
    if (!config.apiToken) return;
    const token = req.headers['x-api-token'];
    if (token !== config.apiToken) {
      throw new ApiError(401, 'UNAUTHORIZED', 'API token 无效');
    }
  }

  function requireIdentity(req: http.IncomingMessage): QqIdentity {
    const userId = req.headers['x-qq-user'];
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new ApiError(401, 'MISSING_IDENTITY', '缺少 X-QQ-User 请求头');
    }
    const groupId = typeof req.headers['x-qq-group'] === 'string' ? req.headers['x-qq-group'] : null;
    const roleHeader = req.headers['x-qq-role'];
    const role =
      roleHeader === 'owner' || roleHeader === 'admin' || roleHeader === 'member'
        ? roleHeader
        : undefined;
    return { userId: userId.trim(), groupId, role };
  }

  function authorize(req: http.IncomingMessage, required: QqPermission): QqIdentity {
    checkToken(req);
    const identity = requireIdentity(req);
    const result = checkPermission({
      identity,
      adminIds: config.qqAdminIds,
      groupIds: config.qqGroupIds,
      required,
    });
    if (!result.ok) {
      throw new ApiError(403, 'FORBIDDEN', result.reason ?? '没有权限');
    }
    return identity;
  }

  /** 解析账号参数：显式指定则校验已监听，否则使用默认账号。 */
  function resolveAccountName(q: URLSearchParams): string {
    const explicit = q.get('account');
    if (explicit && explicit.trim()) {
      const name = explicit.trim().toLowerCase().replace(/^@+/, '');
      if (!services.watch.list().some((a) => a.screenName === name)) {
        throw new ApiError(404, 'NOT_FOUND', `账号未在监听: @${name}`);
      }
      return name;
    }
    const def = services.watch.getDefault();
    if (!def) {
      throw new ApiError(400, 'NO_DEFAULT_ACCOUNT', '未设置默认账号，请用 !监听 默认 @账号 指定');
    }
    return def.screenName;
  }

  async function readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        throw new ApiError(413, 'BODY_TOO_LARGE', '请求体过大');
      }
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON');
    }
  }

  function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    // 末尾带换行：避免 curl 输出后提示符粘连在同一行
    const body = JSON.stringify(payload) + '\n';
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function ok(res: http.ServerResponse, data: unknown): void {
    sendJson(res, 200, { ok: true, data });
  }

  function fail(res: http.ServerResponse, error: unknown): void {
    if (error instanceof ApiError) {
      sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof NotFoundError) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: error.message } });
      return;
    }
    if (error instanceof ValidationError) {
      sendJson(res, 400, { ok: false, error: { code: 'VALIDATION', message: error.message } });
      return;
    }
    if (error instanceof AlreadyExistsError) {
      sendJson(res, 409, { ok: false, error: { code: 'ALREADY_EXISTS', message: error.message } });
      return;
    }
    if (error instanceof IllegalTransitionError) {
      sendJson(res, 409, { ok: false, error: { code: 'ILLEGAL_STATE', message: error.message } });
      return;
    }
    if (error instanceof BilibiliAuthError) {
      sendJson(res, 401, { ok: false, error: { code: 'BILIBILI_AUTH', message: error.message } });
      return;
    }
    if (error instanceof BilibiliApiError || error instanceof BilibiliNetworkError) {
      sendJson(res, 502, { ok: false, error: { code: 'BILIBILI_ERROR', message: error.message } });
      return;
    }
    if (error instanceof NotImplementedError) {
      sendJson(res, 501, { ok: false, error: { code: 'NOT_IMPLEMENTED', message: error.message } });
      return;
    }
    console.error('[api] 未处理错误:', error);
    sendJson(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const pathname = url.pathname;
      const q = url.searchParams;

      // ---- 健康检查（§57）----
      if (method === 'GET' && pathname === '/api/health') {
        const health = await options.tweetToaster.health();
        ok(res, {
          status: 'ok',
          database: 'ok',
          tweettoaster: health ? 'ok' : 'unavailable',
          qq: 'external', // NoneBot2 负责 QQ 收发
        });
        return;
      }

      // ---- 监听管理（§25，管理员）----
      if (method === 'GET' && pathname === '/api/watched-accounts') {
        authorize(req, 'admin');
        ok(res, { accounts: services.watch.list() });
        return;
      }
      if (method === 'POST' && pathname === '/api/watched-accounts') {
        authorize(req, 'admin');
        const body = (await readBody(req)) as { screen_name?: unknown };
        if (typeof body.screen_name !== 'string') {
          throw new ApiError(400, 'BAD_PARAM', '缺少 screen_name');
        }
        ok(res, { account: services.watch.add(body.screen_name) });
        return;
      }
      const accountMatch = /^\/api\/watched-accounts\/([^/]+)$/.exec(pathname);
      if (accountMatch) {
        const screenName = decodeURIComponent(accountMatch[1] ?? '');
        if (method === 'PATCH') {
          authorize(req, 'admin');
          const body = (await readBody(req)) as { enabled?: unknown; default?: unknown };
          if (body.default === true) {
            ok(res, { account: services.watch.setDefault(screenName) });
            return;
          }
          const account = body.enabled ? services.watch.enable(screenName) : services.watch.disable(screenName);
          ok(res, { account });
          return;
        }
        if (method === 'DELETE') {
          authorize(req, 'admin');
          ok(res, services.watch.remove(screenName));
          return;
        }
      }

      // ---- 立即刷新（规格 §8 手动轮询，管理员）----
      if (method === 'POST' && pathname === '/api/refresh') {
        authorize(req, 'admin');
        const body = (await readBody(req)) as { account?: unknown };
        const account =
          typeof body.account === 'string' && body.account.trim()
            ? body.account.trim().replace(/^@+/, '')
            : undefined;
        const results = await services.monitor.refresh(account);
        ok(res, {
          results: results.map((r) => ({
            screenName: r.screenName,
            mode: r.mode,
            timelineCount: r.timelineCount,
            newTweets: r.newTweets.map((t) => ({ id: t.id, seq: t.seq })),
            duplicateCount: r.duplicateCount,
            error: r.error,
          })),
        });
        return;
      }

      // ---- 任务列表 / 多条查看（§26 / §27，成员）----
      if (method === 'GET' && pathname === '/api/tweets') {
        authorize(req, 'member');
        const idsParam = q.get('ids');
        if (idsParam) {
          const ids = idsParam
            .split(/[,，\s]+/)
            .map((s) => Number.parseInt(s, 10))
            .filter((n) => Number.isInteger(n));
          const result = services.tweetQuery.getManyByIds(ids);
          for (const item of result.tweets) {
            resolveTweetMediaPaths(item as unknown as Record<string, unknown>, config.cacheRoot);
          }
          ok(res, result);
          return;
        }
        const filter = parseListFilter(q.get('status'));
        const page = Number.parseInt(q.get('page') ?? '1', 10);
        const pageSize = Number.parseInt(q.get('page_size') ?? '20', 10);
        const accountName = resolveAccountName(q);
        const result = services.tweetQuery.list(filter, { page, pageSize, account: accountName });
        for (const item of result.items) {
          resolveTweetMediaPaths(item as unknown as Record<string, unknown>, config.cacheRoot);
        }
        ok(res, { ...result, account: accountName });
        return;
      }

      // ---- 单条解析（账号内编号 seq；账号缺省用默认账号）----
      if (method === 'GET' && pathname === '/api/tweets/resolve') {
        authorize(req, 'member');
        const seq = Number.parseInt(q.get('seq') ?? '', 10);
        if (!Number.isInteger(seq) || seq < 1) {
          throw new ApiError(400, 'BAD_PARAM', '无效的 seq');
        }
        const accountName = resolveAccountName(q);
        const tweet = services.tweetQuery.getByAccountAndSeq(accountName, seq);
        resolveTweetMediaPaths(tweet as unknown as Record<string, unknown>, config.cacheRoot);
        ok(res, { tweet, format: { view: formatTweetView(tweet) } });
        return;
      }

      // ---- 单条查看（§27，成员）----
      const tweetMatch = /^\/api\/tweets\/(\d+)$/.exec(pathname);
      if (tweetMatch && method === 'GET') {
        authorize(req, 'member');
        const tweet = services.tweetQuery.getById(Number(tweetMatch[1]));
        resolveTweetMediaPaths(tweet as unknown as Record<string, unknown>, config.cacheRoot);
        ok(res, { tweet, format: { view: formatTweetView(tweet) } });
        return;
      }

      // ---- 翻译提交（§28，成员）----
      const translationMatch = /^\/api\/tweets\/(\d+)\/translation$/.exec(pathname);
      if (translationMatch && method === 'POST') {
        authorize(req, 'member');
        const body = (await readBody(req)) as { text?: unknown; qq_user_id?: unknown };
        if (typeof body.text !== 'string') {
          throw new ApiError(400, 'BAD_PARAM', '缺少 text');
        }
        if (typeof body.qq_user_id !== 'string') {
          throw new ApiError(400, 'BAD_PARAM', '缺少 qq_user_id');
        }
        ok(res, { result: services.translation.submit(Number(translationMatch[1]), body.qq_user_id, body.text) });
        return;
      }

      // ---- 话题库（规格 §31：成员可查看，管理员增删；推文不单独绑话题）----
      if (method === 'GET' && pathname === '/api/topics') {
        authorize(req, 'member');
        ok(res, { topics: services.topic.list() });
        return;
      }
      if (method === 'POST' && pathname === '/api/topics') {
        authorize(req, 'admin');
        const body = (await readBody(req)) as { bili_topic_id?: unknown; alias?: unknown; name?: unknown };
        if (typeof body.bili_topic_id !== 'string' || !body.bili_topic_id.trim()) {
          throw new ApiError(400, 'BAD_PARAM', '缺少 bili_topic_id');
        }
        if (typeof body.alias !== 'string' || !body.alias.trim()) {
          throw new ApiError(400, 'BAD_PARAM', '缺少 alias');
        }
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
        ok(res, {
          topic: services.topic.createTopic({
            biliTopicId: body.bili_topic_id.trim(),
            alias: body.alias,
            name,
          }),
        });
        return;
      }
      const topicLibMatch = /^\/api\/topics\/([^/]+)$/.exec(pathname);
      if (topicLibMatch && method === 'DELETE') {
        authorize(req, 'admin');
        ok(res, { removed: services.topic.removeTopic(decodeURIComponent(topicLibMatch[1] ?? '')) });
        return;
      }

      // ---- 发布（§33，管理员）----
      const publishMatch = /^\/api\/tweets\/(\d+)\/publish$/.exec(pathname);
      if (publishMatch && method === 'POST') {
        authorize(req, 'admin');
        const body = (await readBody(req)) as { topic_alias?: unknown };
        const topicAlias = typeof body.topic_alias === 'string' && body.topic_alias ? body.topic_alias : undefined;
        ok(res, { result: await services.publish.publish(Number(publishMatch[1]), topicAlias) });
        return;
      }

      // ---- 重试（§39，管理员）----
      const retryMatch = /^\/api\/tweets\/(\d+)\/retry$/.exec(pathname);
      if (retryMatch && method === 'POST') {
        authorize(req, 'admin');
        ok(res, { result: await services.publish.publish(Number(retryMatch[1])) });
        return;
      }

      // ---- 通知队列（§42，token）----
      if (method === 'GET' && pathname === '/api/notifications') {
        checkToken(req);
        const limit = Math.min(100, Math.max(1, Number.parseInt(q.get('limit') ?? '20', 10)));
        const pending = notifications.listPending(limit);
        for (const n of pending) {
          resolveNotificationMediaPaths(n as unknown as Record<string, unknown>, config.cacheRoot);
        }
        ok(res, { notifications: pending });
        return;
      }
      const ackMatch = /^\/api\/notifications\/(\d+)\/ack$/.exec(pathname);
      if (ackMatch && method === 'POST') {
        checkToken(req);
        ok(res, { acked: notifications.markSent(Number(ackMatch[1])) });
        return;
      }

      // ---- QQ 消息去重（§43，成员）----
      if (method === 'POST' && pathname === '/api/messages/dedupe') {
        authorize(req, 'member');
        const body = (await readBody(req)) as { message_id?: unknown };
        if (typeof body.message_id !== 'string' || !body.message_id) {
          throw new ApiError(400, 'BAD_PARAM', '缺少 message_id');
        }
        ok(res, { duplicate: messageDedupe.markProcessed(body.message_id) });
        return;
      }

      console.log(`[api] 404 ${method} ${pathname}`); // 调试用：暴露未匹配路由的真实路径
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      fail(res, error);
    }
  });
}
