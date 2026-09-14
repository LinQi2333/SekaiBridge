import type { NewTweetInput, TweetMedia } from '../domain/tweet.js';
import type { ToasterMedia, ToasterStatus, ToasterTweetResponse } from './types.js';

/**
 * 把 TweetToaster 标准化数据适配为主项目的 domain 输入（规格 §16 / §18 / §21）。
 *
 * photo 一律取最高画质原图（Twitter CDN 的 name=orig）；
 * video/gif 的 url 是默认封面（TweetToaster 已替换），本项目不再下载视频封面。
 */
export function toDomainMedia(media: ToasterMedia[]): TweetMedia[] {
  return media.map((item) => {
    const isVideoLike = item.type === 'video' || item.type === 'gif';
    return {
      type: item.type,
      url: isVideoLike ? item.url : toOriginalQualityUrl(item.url),
      thumbnail_url: isVideoLike ? item.url : null,
      width: item.width > 0 ? item.width : null,
      height: item.height > 0 ? item.height : null,
      alt: item.alt?.trim() ? item.alt : null,
    };
  });
}

/** Twitter 图片最高画质参数。 */
export const TWITTER_ORIGINAL_QUALITY = 'orig';

/**
 * 把 Twitter 图片 URL 规范为最高画质（name=orig）。
 * 非 twimg 域名或解析失败时原样返回。
 */
export function toOriginalQualityUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/\.twimg\.com$/i.test(parsed.hostname)) {
      return url;
    }
    parsed.searchParams.set('name', TWITTER_ORIGINAL_QUALITY);
    return parsed.toString();
  } catch {
    return url;
  }
}

/** 单条 Toaster 推文 → NewTweetInput；推文无效（无 id / 无作者）时返回 null。 */
export function toNewTweetInput(status: ToasterStatus): NewTweetInput | null {
  if (!status?.id || !status.author?.screenName) {
    return null;
  }
  return {
    xTweetId: String(status.id),
    authorScreenName: status.author.screenName,
    authorName: status.author.name || null,
    tweetUrl: status.url,
    originalText: status.text || '',
    createdAtX: status.createdAt,
    media: toDomainMedia(status.media ?? []),
    rawJson: status,
  };
}

/** 响应中的焦点（目标）推文 → NewTweetInput；全部失效时返回 null。 */
export function toFocalTweet(response: ToasterTweetResponse): NewTweetInput | null {
  const focal =
    response.tweets[response.focalIndex] ?? response.tweets.find((tweet) => tweet.focal) ?? null;
  return focal ? toNewTweetInput(focal) : null;
}

/** timeline 响应：全部推文 → NewTweetInput[]（去重交给 Monitor，规格 §8）。 */
export function toNewTweetInputs(response: ToasterTweetResponse): NewTweetInput[] {
  const inputs: NewTweetInput[] = [];
  const seen = new Set<string>();
  for (const status of response.tweets ?? []) {
    const input = toNewTweetInput(status);
    if (!input || seen.has(input.xTweetId)) continue;
    seen.add(input.xTweetId);
    inputs.push(input);
  }
  return inputs;
}
