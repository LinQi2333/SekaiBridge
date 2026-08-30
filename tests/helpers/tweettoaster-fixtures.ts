import type { ToasterStatus, ToasterTweetResponse } from '../../src/tweettoaster/types.ts';

/** 构造单条 Toaster 推文（模拟 TweetToaster 标准化输出）。 */
export function toasterStatus(overrides: Partial<ToasterStatus> = {}): ToasterStatus {
  return {
    id: '1890000000000000000',
    url: 'https://x.com/example/status/1890000000000000000',
    focal: true,
    relation: 'target',
    text: '今日も頑張る！🌸',
    lang: 'ja',
    createdAt: '2026-08-30T02:15:00.000Z',
    author: {
      name: 'Example Channel',
      screenName: 'example',
      avatarUrl: 'https://pbs.twimg.com/profile/a.jpg',
      verified: false,
    },
    counts: { replies: 0, reposts: 1, likes: 3, views: 100 },
    media: [
      { type: 'photo', url: 'https://pbs.twimg.com/media/photo1.jpg', width: 1920, height: 1080, alt: '' },
    ],
    quote: null,
    replyingTo: null,
    replyingToStatusId: null,
    ...overrides,
  };
}

/** 构造 /api/tweet 响应（conversation 模式）。 */
export function toasterResponse(overrides: Partial<ToasterTweetResponse> = {}): ToasterTweetResponse {
  const status = toasterStatus();
  return {
    id: status.id,
    canonicalUrl: status.url,
    mode: 'conversation',
    query: { kind: 'status', screenName: 'example', canonicalUrl: status.url },
    focalIndex: 0,
    tweets: [status],
    ...overrides,
  };
}

/** 视频推文响应：url 为默认封面（TweetToaster 的 normalizeMedia 行为）。 */
export function toasterVideoResponse(): ToasterTweetResponse {
  return toasterResponse({
    tweets: [
      toasterStatus({
        media: [
          {
            type: 'video',
            url: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/cover.jpg',
            width: 1280,
            height: 720,
            alt: '',
          },
        ],
      }),
    ],
  });
}

/** 混合媒体推文：photo A + video B + photo C（规格 §21）。 */
export function toasterMixedResponse(): ToasterTweetResponse {
  return toasterResponse({
    tweets: [
      toasterStatus({
        media: [
          { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1000, height: 800, alt: '' },
          {
            type: 'video',
            url: 'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/b.jpg',
            width: 640,
            height: 360,
            alt: '',
          },
          { type: 'photo', url: 'https://pbs.twimg.com/media/c.jpg', width: 1000, height: 800, alt: 'alt text' },
        ],
      }),
    ],
  });
}

/** timeline 响应：多条推文。 */
export function toasterTimelineResponse(): ToasterTweetResponse {
  return toasterResponse({
    mode: 'timeline',
    query: { kind: 'profile', screenName: 'example', canonicalUrl: 'https://x.com/example' },
    tweets: [
      toasterStatus({ id: '300', url: 'https://x.com/example/status/300', focal: true, relation: 'timeline' }),
      toasterStatus({ id: '200', url: 'https://x.com/example/status/200', focal: false, relation: 'timeline' }),
      toasterStatus({ id: '100', url: 'https://x.com/example/status/100', focal: false, relation: 'timeline' }),
    ],
  });
}
