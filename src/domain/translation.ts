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
 * 只允许 \r\n → \n，禁止删除 emoji、合并换行、润色、改写、繁简转换、AI 翻译等。
 */
export function normalizeTranslationText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
