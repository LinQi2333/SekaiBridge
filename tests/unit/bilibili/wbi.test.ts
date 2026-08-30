import { describe, expect, it } from 'vitest';
import {
  encodeWbiParam,
  extractKeyFromImageUrl,
  getMixinKey,
  signWbi,
} from '../../../src/bilibili/wbi.js';

describe('wbi 签名（Bilibili 动态接口）', () => {
  it('mixin key 计算与官方示例一致', () => {
    // 官方参考示例：https://github.com/SocialSisterYi/bilibili-API-collect
    const imgKey = '7cd084941338484aae1ad9425b84077c';
    const subKey = '4932caff0ff746eab6f01bf08b70ac45';
    expect(getMixinKey(imgKey, subKey)).toBe('ea1db124af3c7062474693fa704f4ff8');
  });

  it('从 wbi_img URL 提取 key', () => {
    expect(extractKeyFromImageUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(
      '7cd084941338484aae1ad9425b84077c',
    );
    expect(extractKeyFromImageUrl('https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.webp')).toBe(
      '4932caff0ff746eab6f01bf08b70ac45',
    );
  });

  it('encodeWbiParam 过滤特殊字符', () => {
    expect(encodeWbiParam('a b!c*d(e)')).toBe('a%20bcde');
    // 空格 → %20，!'()* 被移除，普通字符保留
    expect(encodeWbiParam('测试')).toBe('%E6%B5%8B%E8%AF%95');
  });

  it('signWbi 生成 w_rid（32 位 hex）与 wts', () => {
    const result = signWbi(
      { type: 4, biz_id: '[]', content: '译文' },
      '7cd084941338484aae1ad9425b84077c',
      '4932caff0ff746eab6f01bf08b70ac45',
      1700000000,
    );
    expect(result.wts).toBe(1700000000);
    expect(result.w_rid).toMatch(/^[0-9a-f]{32}$/);
    // 相同输入 → 相同签名（确定性）
    const again = signWbi(
      { type: 4, biz_id: '[]', content: '译文' },
      '7cd084941338484aae1ad9425b84077c',
      '4932caff0ff746eab6f01bf08b70ac45',
      1700000000,
    );
    expect(again).toEqual(result);
  });
});
