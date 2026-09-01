import type { Tweet } from '../domain/tweet.js';
import { hasVideo } from '../domain/tweet.js';
import { SourceStatus } from '../domain/workflow.js';

/**
 * QQ 展示格式化（规格 §42 / §26 / §27 / §51）。
 * 核心约束：新推文通知与 /查看 都不输出 original_text（规格 ㉒ / §51）。
 * NoneBot2 插件可直接使用通知文本；命令响应文本参考这里实现。
 */

/** ISO 时间 → 'YYYY-MM-DD HH:mm'（本地时区）。 */
export function toDisplayTime(iso: string | null): string {
  if (!iso) return '未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 工作流状态 → 群内展示用中文标签。 */
export function workflowLabel(status: string): string {
  const labels: Record<string, string> = {
    DETECTED: '待处理',
    SCREENSHOT_READY: '截图完成',
    QQ_SENT: '已发群',
    WAITING_TRANSLATION: '待翻译',
    TRANSLATED: '已翻译，等待发布',
    READY_TO_PUBLISH: '待发布',
    PUBLISHING: '发布中',
    PUBLISHED: '已发布',
    PUBLISH_FAILED: '发布失败',
  };
  return labels[status] ?? status;
}

/** 来源状态 → 群内展示用文本。 */
export function sourceLabel(status: string): string {
  return status === SourceStatus.SOURCE_DELETED ? '⚠️ 原推已删除' : '正常';
}

/**
 * 新推文自动通知文本（规格 §42 / §51）。
 * 不含 original_text；包含 local id、账号、时间、状态、推文 URL。
 * 视频推文追加"包含视频"提示（规格 §18 / §42 视频版）。
 */
export function formatNewTweetNotification(tweet: Tweet): string {
  const video = hasVideo(tweet);
  const lines = [
    `【新推文 #${tweet.id}】`,
    '',
    `账号：@${tweet.authorScreenName}`,
    `时间：${toDisplayTime(tweet.createdAtX)}`,
    '状态：待翻译',
    '',
    '原推：',
    tweet.tweetUrl,
  ];
  if (video) {
    lines.push(
      '',
      '⚠️ 此推文包含视频。',
      '下方图片为视频默认封面，视频本体不会下载或转载。',
    );
  }
  return lines.join('\n');
}

/** /查看 输出文本（规格 §27）：状态 + 原推链接，不含原文正文。 */
export function formatTweetView(tweet: Tweet): string {
  const lines = [
    `#${tweet.id}`,
    `@${tweet.authorScreenName}`,
    '',
    `来源状态：${sourceLabel(tweet.sourceStatus)}`,
    `工作状态：${workflowLabel(tweet.workflowStatus)}`,
    '',
    '原推：',
    tweet.tweetUrl,
  ];
  if (tweet.lastError) {
    lines.push('', `上次错误：${tweet.lastError}`);
  }
  return lines.join('\n');
}

/** /列表 单行（规格 §26 示例：`#155 @foo   待翻译`）。 */
export function formatTweetListLine(tweet: Tweet): string {
  const deleted = tweet.sourceStatus === SourceStatus.SOURCE_DELETED ? '原推已删除 / ' : '';
  return `#${tweet.id} @${tweet.authorScreenName}   ${deleted}${workflowLabel(tweet.workflowStatus)}`;
}

/** 翻译提交后的 QQ 回复（规格 §30）。 */
export function formatTranslationSaved(tweetId: number, version: number): string {
  return [
    `推文 #${tweetId} 翻译已保存。`,
    '',
    `当前版本：v${version}`,
    '状态：已翻译，等待发布。',
    '',
    '可继续：',
    `/发布 ${tweetId} [话题别名]`,
  ].join('\n');
}

/** 话题库列表输出（规格 §31）。 */
export function formatTopicList(topics: { alias: string; name: string; biliTopicId: string }[]): string {
  if (topics.length === 0) {
    return '可用话题：\n\n（暂无话题，请联系管理员添加）';
  }
  const width = Math.max(...topics.map((t) => t.alias.length)) + 3;
  const lines = topics.map((t) => `${t.alias.padEnd(width)}${t.name}（#${t.biliTopicId}）`);
  return `可用话题：\n\n${lines.join('\n')}`;
}
