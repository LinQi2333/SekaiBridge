import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

/** 外部媒体使用代理；内部服务及 NO_PROXY 指定的目标直连。 */
export function createProxyFetch(
  env: NodeJS.ProcessEnv = process.env,
  directUrls: string[] = [],
): typeof fetch {
  const httpProxy = env.HTTP_PROXY || env.http_proxy || '';
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy || httpProxy;
  if (!httpProxy && !httpsProxy) return globalThis.fetch;
  const directOrigins = new Set(directUrls.map((url) => new URL(url).origin));
  const agent = new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: env.NO_PROXY ?? env.no_proxy ?? '',
  });
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (directOrigins.has(url.origin)) return globalThis.fetch(input, init);
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher: agent,
    });
  }) as typeof fetch;
}
