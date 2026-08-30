/**
 * 极简事件日志（规格 §56）。
 * 事件命名如 tweet.detected / tweet.duplicate / monitor.poll.error 等。
 * 禁止打印 secrets（Bilibili Cookie、access token 等）。
 */
export function log(event: string, message = ''): void {
  console.log(`[${new Date().toISOString()}] [${event}] ${message}`);
}
