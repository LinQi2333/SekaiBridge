import { describe, expect, it } from 'vitest';
import { hasVideo, parseMedia, photoMedia, type TweetMedia } from '../../src/domain/tweet.js';

const media: TweetMedia[] = [
  { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1920, height: 1080 },
  { type: 'video', url: 'https://video.twimg.com/x.mp4', thumbnail_url: 'https://pbs.twimg.com/t.jpg' },
  { type: 'gif', url: 'https://video.twimg.com/y.mp4', thumbnail_url: 'https://pbs.twimg.com/t2.jpg' },
];

describe('tweet 媒体（规格 §16 / §21）', () => {
  it('空 media_json 解析为空数组', () => {
    expect(parseMedia(null)).toEqual([]);
    expect(parseMedia('')).toEqual([]);
    expect(parseMedia('not json')).toEqual([]);
  });

  it('解析 media_json', () => {
    const parsed = parseMedia(JSON.stringify(media));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.type).toBe('photo');
    expect(parsed[1]?.type).toBe('video');
    expect(parsed[1]?.thumbnail_url).toBe('https://pbs.twimg.com/t.jpg');
    expect(parsed[2]?.type).toBe('gif');
  });

  it('hasVideo 识别 video / gif', () => {
    expect(hasVideo({ mediaJson: JSON.stringify(media) })).toBe(true);
    expect(hasVideo({ mediaJson: JSON.stringify([media[0]]) })).toBe(false);
    expect(hasVideo({ mediaJson: null })).toBe(false);
  });

  it('photoMedia 只保留 photo（视频封面不上传 Bilibili）', () => {
    const photos = photoMedia({ mediaJson: JSON.stringify(media) });
    expect(photos).toHaveLength(1);
    expect(photos[0]?.type).toBe('photo');
  });
});
