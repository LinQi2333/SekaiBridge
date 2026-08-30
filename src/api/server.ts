import http from 'node:http';
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
    return { userId: userId.trim(), groupId };
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
    const body = JSON.stringify(payload);
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
          const body = (await readBody(req)) as { enabled?: unknown };
          const account = body.enabled ? services.watch.enable(screenName) : services.watch.disable(screenName);
          ok(res, { account });
          return;
        }
        if (method === 'DELETE') {
          authorize(req, 'admin');
          ok(res, { removed: services.watch.remove(screenName) });
          return;
        }
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
          ok(res, result);
          return;
        }
        const filter = parseListFilter(q.get('status'));
        const page = Number.parseInt(q.get('page') ?? '1', 10);
        const pageSize = Number.parseInt(q.get('page_size') ?? '20', 10);
        const result = services.tweetQuery.list(filter, { page, pageSize });
        ok(res, result);
        return;
      }

      // ---- 单条查看（§27，成员）----
      const tweetMatch = /^\/api\/tweets\/(\d+)$/.exec(pathname);
      if (tweetMatch && method === 'GET') {
        authorize(req, 'member');
        const tweet = services.tweetQuery.getById(Number(tweetMatch[1]));
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

      // ---- 话题设置（§32，成员）----
      const topicMatch = /^\/api\/tweets\/(\d+)\/topic$/.exec(pathname);
      if (topicMatch && method === 'POST') {
        authorize(req, 'member');
        const body = (await readBody(req)) as { alias?: unknown };
        const alias = body.alias === null || body.alias === undefined ? null : String(body.alias);
        const tweet = alias === null ? services.topic.setTopic(Number(topicMatch[1]), null) : services.topic.setTopic(Number(topicMatch[1]), alias);
        ok(res, { tweet });
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
        ok(res, { notifications: notifications.listPending(limit) });
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

      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      fail(res, error);
    }
  });
}
