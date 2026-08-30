import { createHash } from 'node:crypto';

/**
 * Bilibili wbi 签名（动态发布接口需要）。
 * 参考官方前端 wbi 签名算法：mixinKeyEncTab 固定打乱表 + md5。
 */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

/** 由 nav 接口的 img_key / sub_key 计算 mixin key。 */
export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '')
    .join('')
    .slice(0, 32);
}

/** 从 wbi_img 图片 URL 提取 key（去掉路径与扩展名）。 */
export function extractKeyFromImageUrl(url: string): string {
  const name = url.split('/').pop() ?? '';
  return name.replace(/\.(png|jpg|jpeg|webp)$/i, '');
}

/** encodeURIComponent 后再过滤 Bilibili 规定的特殊字符。 */
export function encodeWbiParam(value: string | number): string {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, '');
}

export interface WbiSignResult {
  w_rid: string;
  wts: number;
}

/**
 * 计算 wbi 签名（规格参数按 key 排序 + wts + mixin key 拼接后 md5）。
 * 返回需要追加到请求参数中的 w_rid / wts。
 */
export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): WbiSignResult {
  const mixinKey = getMixinKey(imgKey, subKey);
  const query: Record<string, string | number> = { ...params, wts: nowSeconds };
  const sorted = Object.keys(query)
    .sort()
    .map((key) => `${encodeWbiParam(key)}=${encodeWbiParam(query[key] ?? '')}`)
    .join('&');
  const w_rid = createHash('md5').update(sorted + mixinKey).digest('hex');
  return { w_rid, wts: nowSeconds };
}
