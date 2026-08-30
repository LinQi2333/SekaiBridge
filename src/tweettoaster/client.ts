import {
  TweetNotFoundError,
  TweetToasterError,
  TweetToasterUnavailableError,
} from './errors.js';
import { normalizeContentType } from '../media/safe-download.js';
import type {
  ToasterHealthResponse,
  ToasterTaskResponse,
  ToasterTaskState,
  ToasterTweetResponse,
} from './types.js';

export interface TweetToasterClientOptions {
  /** 例如 http://tweettoaster:8082（不带尾部斜杠）。 */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** 单次 HTTP 请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 任务轮询间隔（毫秒）。 */
  pollIntervalMs?: number;
  /** 任务轮询总超时（毫秒）。 */
  pollTimeoutMs?: number;
}

/** POST /api/auto 请求体（Bot 兼容协议）。 */
export interface AutoRequest {
  tweet: string;
  translate?: string;
  template?: string;
  noLikes?: boolean;
  logo?: 'official' | 'keke' | 'magic' | 'none' | 'custom';
}

/** POST /api/render 请求体（selection 必填，规格 §65）。 */
export interface RenderRequest extends AutoRequest {
  selection: { id: string; translation?: string }[];
}

interface ToasterErrorBody {
  error?: { code?: string; message?: string };
}

export const DEFAULT_CLIENT_OPTIONS = {
  timeoutMs: 15_000,
  pollIntervalMs: 1_000,
  pollTimeoutMs: 120_000,
} as const;

/**
 * TweetToaster 独立服务客户端（规格 §14）。
 * 主程序只调用 /api/tweet、/api/render、/api/auto、/api/get_task，
 * 不重新实现 Twitter 抓取。
 */
export class TweetToasterClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(options: TweetToasterClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_OPTIONS.timeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CLIENT_OPTIONS.pollIntervalMs;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_CLIENT_OPTIONS.pollTimeoutMs;
  }

  /** GET /api/health。服务不可达时返回 null（不抛错，供 health check 聚合）。 */
  async health(): Promise<ToasterHealthResponse | null> {
    try {
      const payload = await this.#request('/api/health');
      return payload as ToasterHealthResponse;
    } catch {
      return null;
    }
  }

  /**
   * POST /api/tweet。
   * 接受单推链接 / 主页链接 / @用户名，返回标准化响应。
   * 推文明确不存在（404 / tombstone）时抛 TweetNotFoundError。
   */
  async getTweet(input: string): Promise<ToasterTweetResponse> {
    const payload = await this.#request('/api/tweet', {
      method: 'POST',
      body: JSON.stringify({ url: input }),
    });
    return payload as ToasterTweetResponse;
  }

  /** 取某账号近期 timeline（TweetToaster 主页模式，默认最多 12 条）。 */
  async getTimeline(screenName: string): Promise<ToasterTweetResponse> {
    const input = screenName.startsWith('@') ? screenName : `@${screenName}`;
    return this.getTweet(input);
  }

  /** POST /api/render 并轮询任务完成，返回截图 PNG 的完整 URL。 */
  async render(request: RenderRequest): Promise<string> {
    const { task_id: taskId } = (await this.#request('/api/render', {
      method: 'POST',
      body: JSON.stringify(request),
    })) as { task_id: string };
    const task = await this.waitForTask(taskId);
    return screenshotUrl(this.baseUrl, task.result);
  }

  /** POST /api/auto（旧 Bot 兼容协议）并轮询，返回截图 PNG 的完整 URL。 */
  async auto(request: AutoRequest): Promise<string> {
    const { task_id: taskId } = (await this.#request('/api/auto', {
      method: 'POST',
      body: JSON.stringify(request),
    })) as { task_id: string };
    const task = await this.waitForTask(taskId);
    return screenshotUrl(this.baseUrl, task.result);
  }

  /** GET /api/task=<id>。 */
  async getTask(taskId: string): Promise<ToasterTaskResponse> {
    const payload = await this.#request(`/api/get_task=${encodeURIComponent(taskId)}`);
    return payload as ToasterTaskResponse;
  }

  /**
   * 通过 TweetToaster 的图片代理下载远程图片（GET /api/media?url=）。
   * 用于主程序无法直连 Twitter CDN（pbs.twimg.com 等）的部署环境。
   */
  async downloadMedia(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/media?url=${encodeURIComponent(url)}`,
        { signal: controller.signal },
      );
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new TweetToasterUnavailableError(
        timedOut ? `媒体代理请求超时: ${truncate(url, 200)}` : `媒体代理请求失败: ${truncate(url, 200)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new TweetToasterError(`媒体代理返回 HTTP ${response.status}: ${truncate(url, 200)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = normalizeContentType(response.headers.get('content-type'));
    return { bytes, contentType };
  }

  /** 轮询任务直到 SUCCESS / FAILURE，成功返回最终任务。 */
  async waitForTask(taskId: string): Promise<ToasterTaskResponse> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const task = await this.getTask(taskId);
      if (task.state === 'SUCCESS') {
        if (!task.result) {
          throw new TweetToasterError(`任务 ${taskId} 成功但没有结果文件`);
        }
        return task;
      }
      if (task.state === 'FAILURE') {
        throw new TweetToasterError(`TweetToaster 任务失败: ${task.error ?? '未知错误'}`);
      }
      if (Date.now() >= deadline) {
        throw new TweetToasterError(`等待 TweetToaster 任务超时: ${taskId}`);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  async #request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...init.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new TweetToasterUnavailableError(
        timedOut
          ? `TweetToaster 请求超时: ${pathname}`
          : `无法连接 TweetToaster: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // 非 JSON 响应按错误处理
    }

    if (!response.ok) {
      this.#throwHttpError(response.status, payload);
    }
    return payload;
  }

  #throwHttpError(status: number, payload: unknown): never {
    const body = (payload ?? {}) as ToasterErrorBody;
    const code = body.error?.code ?? null;
    const message = body.error?.message ?? `TweetToaster 错误 (HTTP ${status})`;
    if (status === 404 || code === 'TWEET_NOT_FOUND' || code === 'TIMELINE_NOT_FOUND') {
      throw new TweetNotFoundError(message, { code: code ?? undefined });
    }
    throw new TweetToasterError(message, { status, code: code ?? undefined });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** TweetToaster 任务 result 是文件名（无扩展名），实际图片为 /cache/<result>.png。 */
function screenshotUrl(baseUrl: string, result: string | null): string {
  if (!result) {
    throw new TweetToasterError('任务成功但没有结果文件');
  }
  const filename = result.endsWith('.png') ? result : `${result}.png`;
  return `${baseUrl}/cache/${filename}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export type { ToasterTaskState };
