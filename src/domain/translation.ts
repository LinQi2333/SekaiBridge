import type { WorkflowStatus } from './workflow.js';

/** 翻译版本（规格 §29）。后一次 /翻译 使 version += 1，最新版本为当前有效版本，旧版本保留。 */
export interface Translation {
  id: number;
  tweetId: number;
  /** 提交者的 QQ 号。 */
  qqUserId: string;
  text: string;
  version: number;
  createdAt: string;
}

/** 翻译提交输入。 */
export interface NewTranslationInput {
  tweetId: number;
  qqUserId: string;
  text: string;
}

/** 翻译提交的结果（含提交后的推文工作流状态，供 QQ 回复展示）。 */
export interface TranslationSubmitResult {
  translation: Translation;
  workflowStatus: WorkflowStatus;
}

/**
 * 翻译文本规范化（规格 §28）：
 * 只统一"换行符写法"，禁止删除 emoji、合并空行、润色、改写、繁简转换、AI 翻译等。
 *
 * 统一的范围：CRLF / 单独的 CR / U+2028 / U+2029 / NEL(0x85) → `\n`。
 * 这些字符在 QQ 等客户端里都显示为换行，但只有 `\n` 会被我们的解析逻辑识别，
 * 历史上曾因此出现"翻译第一行被吞"的问题（命令行与正文之间是 CR 时）。
 */
export function normalizeTranslationText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029\u0085]/g, '\n');
}
