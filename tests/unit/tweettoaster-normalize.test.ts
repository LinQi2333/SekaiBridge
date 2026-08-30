import { describe, expect, it } from 'vitest';
import {
  toDomainMedia,
  toFocalTweet,
  toNewTweetInput,
  toNewTweetInputs,
} from '../../src/tweettoaster/normalize.ts';
import {
  toasterMixedResponse,
  toasterResponse,
  toasterStatus,
  toasterTimelineResponse,
  toasterVideoResponse,
} from '../helpers/tweettoaster-fixtures.ts';

describe('媒体标准化（规格 §16 / §18 / §21）', () => {
  it('photo 保留原图，thumbnail_url 为 null', () => {
    const [photo] = toDomainMedia([
      { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1920, height: 1080, alt: '' },
    ]);
    expect(photo).toEqual({
      type: 'photo',
      url: 'https://pbs.twimg.com/media/a.jpg',
      thumbnail_url: null,
      width: 1920,
      height: 1080,
      alt: null,
    });
  });

  it('video / gif 的 url 即默认封面（TweetToaster normalizeMedia 行为）', () => {
    const media = toDomainMedia([
      { type: 'video', url: 'https://pbs.twimg.com/cover.jpg', width: 1280, height: 720, alt: '说明' },
      { type: 'gif', url: 'https://pbs.twimg.com/gif-cover.jpg', width: 0, height: 0, alt: '' },
    ]);
    expect(media[0]?.thumbnail_url).toBe('https://pbs.twimg.com/cover.jpg');
    expect(media[0]?.alt).toBe('说明');
    // width/height 为 0 时映射为 null
    expect(media[1]?.width).toBeNull();
    expect(media[1]?.height).toBeNull();
  });

  it('混合媒体（photo + video + photo）类型与顺序保留', () => {
    const input = toFocalTweet(toasterMixedResponse());
    expect(input?.media?.map((m) => m.type)).toEqual(['photo', 'video', 'photo']);
    expect(input?.media?.map((m) => m.url)).toEqual([
      'https://pbs.twimg.com/media/a.jpg',
      'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/b.jpg',
      'https://pbs.twimg.com/media/c.jpg',
    ]);
    // 视频封面可识别（用于 QQ 提示"包含视频"）
    expect(input?.media?.filter((m) => m.type === 'video' || m.type === 'gif')).toHaveLength(1);
  });
});

describe('推文标准化', () => {
  it('焦点推文 → NewTweetInput，字段完整映射', () => {
    const input = toFocalTweet(toasterResponse());
    expect(input).toMatchObject({
      xTweetId: '1890000000000000000',
      authorScreenName: 'example',
      authorName: 'Example Channel',
      tweetUrl: 'https://x.com/example/status/1890000000000000000',
      originalText: '今日も頑張る！🌸',
      createdAtX: '2026-08-30T02:15:00.000Z',
    });
    expect(input?.media).toHaveLength(1);
  });

  it('视频推文进入工作流（url 即封面），原视频文件不下载', () => {
    const input = toFocalTweet(toasterVideoResponse());
    expect(input?.media?.[0]?.type).toBe('video');
    expect(input?.media?.[0]?.thumbnail_url).toBe(
      'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/cover.jpg',
    );
  });

  it('无 id / 无作者的推文返回 null', () => {
    expect(toNewTweetInput(toasterStatus({ id: '', author: { ...toasterStatus().author } }))).toBeNull();
    expect(
      toNewTweetInput(
        toasterStatus({ author: { name: '', screenName: '', avatarUrl: '', verified: false } }),
      ),
    ).toBeNull();
  });

  it('timeline 响应映射为多条且按出现顺序去重', () => {
    const inputs = toNewTweetInputs(toasterTimelineResponse());
    expect(inputs.map((i) => i.xTweetId)).toEqual(['300', '200', '100']);
  });

  it('响应为空（全部 tombstone）时返回 null / 空数组', () => {
    const empty = toasterResponse({ tweets: [], focalIndex: -1 });
    expect(toFocalTweet(empty)).toBeNull();
    expect(toNewTweetInputs(empty)).toEqual([]);
  });
});
