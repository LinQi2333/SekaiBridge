/**
 * 007_normalize_legacy_statuses：把历史遗留的工作流状态归一到当前状态机。
 *
 * 背景：三个状态在当前代码里已经不会再产生，只可能残留于老数据：
 *   - QQ_SENT          旧版由主程序自己推送 QQ 后标记（现在由 NoneBot2 轮询，不再标记）
 *   - WAITING_TRANSLATION  旧版的"等待翻译"中间态（现在停在 SCREENSHOT_READY）
 *   - READY_TO_PUBLISH 自动发布模式用（现在 PUBLISH_MODE=manual）
 * 这些行会永远挂在 /列表 的"待翻译 / 已翻译"里出不来，所以统一归位。
 *
 * 另外处理"滞留在 PUBLISHING"的行（发布过程中进程被杀）：
 *   有成功发布记录 → PUBLISHED；否则有翻译 → TRANSLATED；否则 → SCREENSHOT_READY。
 *
 * 纯数据迁移、幂等（再次执行不会改变任何行），不需要改动 updated_at。
 */
export const up = `
UPDATE tweets SET workflow_status = 'SCREENSHOT_READY'
 WHERE workflow_status IN ('QQ_SENT', 'WAITING_TRANSLATION');

UPDATE tweets SET workflow_status = 'TRANSLATED'
 WHERE workflow_status = 'READY_TO_PUBLISH';

UPDATE tweets SET workflow_status = 'PUBLISHED'
 WHERE workflow_status = 'PUBLISHING'
   AND EXISTS (
     SELECT 1 FROM publish_records p
      WHERE p.tweet_id = tweets.id AND p.status = 'SUCCESS'
   );

UPDATE tweets SET workflow_status = 'TRANSLATED'
 WHERE workflow_status = 'PUBLISHING'
   AND EXISTS (
     SELECT 1 FROM translations t WHERE t.tweet_id = tweets.id
   );

UPDATE tweets SET workflow_status = 'SCREENSHOT_READY'
 WHERE workflow_status = 'PUBLISHING';
`;
