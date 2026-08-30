import { describe, expect, it } from 'vitest';
import { normalizeTranslationText } from '../../src/domain/translation.js';

describe('翻译文本规范化（规格 §28 / §49）', () => {
  it('只做 \\r\\n → \\n，其余内容逐字保留', () => {
    const input = '今天也辛苦啦～！🌸\r\n\r\n晚上还有直播，\r\n记得来看哦！✨';
    const expected = '今天也辛苦啦～！🌸\n\n晚上还有直播，\n记得来看哦！✨';
    expect(normalizeTranslationText(input)).toBe(expected);
  });

  it('保留 emoji / Unicode / 颜文字 / 空行 / URL', () => {
    const input = '中文テスト English (｡･ω･｡) 🥹❤️✨\n\nhttps://example.com/a?b=1&c=2';
    expect(normalizeTranslationText(input)).toBe(input);
  });

  it('纯 \\n 输入不变', () => {
    const input = '第一行\n第二行';
    expect(normalizeTranslationText(input)).toBe(input);
  });
});
