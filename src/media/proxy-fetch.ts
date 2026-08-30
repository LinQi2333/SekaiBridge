import { ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * 构造 fetch：若配置了 HTTPS_PROXY / HTTP_PROXY（或小写），
 * 则通过 undici ProxyAgent 走代理（用于国内直连 Twitter CDN 失败的环境）。
 * 未配置代理时返回全局 fetch。
 */
export function createProxyFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  const proxy =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    '';
  if (!proxy) {
    return globalThis.fetch;
  }
  const agent = new ProxyAgent(proxy);
  const proxyFetch = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher: agent,
    })) as typeof fetch;
  return proxyFetch;
}
