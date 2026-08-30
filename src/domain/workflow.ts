/**
 * 工作流状态与来源状态是两个独立维度（规格 §11）。
 *
 * 一条推文可以"已经翻译但原推被删除"、
 * 也可以"已经发布之后原推被删除"，因此两者必须分离存储。
 */

/** 推文工作流状态。 */
export enum WorkflowStatus {
  /** 新推文被检测到并保存。 */
  DETECTED = 'DETECTED',
  /** 推文截图已生成。 */
  SCREENSHOT_READY = 'SCREENSHOT_READY',
  /** 已发送到 QQ 群。 */
  QQ_SENT = 'QQ_SENT',
  /** 等待群成员翻译。 */
  WAITING_TRANSLATION = 'WAITING_TRANSLATION',
  /** 已提交最终翻译，等待发布。 */
  TRANSLATED = 'TRANSLATED',
  /** 准备好发布（自动发布模式使用）。 */
  READY_TO_PUBLISH = 'READY_TO_PUBLISH',
  /** 正在发布到 Bilibili。 */
  PUBLISHING = 'PUBLISHING',
  /** 已成功发布到 Bilibili。 */
  PUBLISHED = 'PUBLISHED',
  /** 发布失败，可重试。 */
  PUBLISH_FAILED = 'PUBLISH_FAILED',
}

/** 推文来源状态。 */
export enum SourceStatus {
  /** 原推正常。 */
  ACTIVE = 'ACTIVE',
  /** 原推已删除（由单推检查明确确认，不是"不在 timeline"）。 */
  SOURCE_DELETED = 'SOURCE_DELETED',
}

/**
 * 允许的工作流转移。
 * 不在映射中的转移视为非法（抛错），防止状态机漂移。
 */
export const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  [WorkflowStatus.DETECTED]: [
    WorkflowStatus.SCREENSHOT_READY,
    WorkflowStatus.WAITING_TRANSLATION,
    WorkflowStatus.TRANSLATED,
  ],
  [WorkflowStatus.SCREENSHOT_READY]: [
    WorkflowStatus.QQ_SENT,
    WorkflowStatus.WAITING_TRANSLATION,
    WorkflowStatus.TRANSLATED,
  ],
  [WorkflowStatus.QQ_SENT]: [
    WorkflowStatus.WAITING_TRANSLATION,
    WorkflowStatus.TRANSLATED,
  ],
  [WorkflowStatus.WAITING_TRANSLATION]: [
    WorkflowStatus.TRANSLATED,
  ],
  [WorkflowStatus.TRANSLATED]: [
    WorkflowStatus.READY_TO_PUBLISH,
    WorkflowStatus.PUBLISHING,
  ],
  [WorkflowStatus.READY_TO_PUBLISH]: [
    WorkflowStatus.PUBLISHING,
  ],
  [WorkflowStatus.PUBLISHING]: [
    WorkflowStatus.PUBLISHED,
    WorkflowStatus.PUBLISH_FAILED,
  ],
  [WorkflowStatus.PUBLISH_FAILED]: [
    WorkflowStatus.PUBLISHING,
    WorkflowStatus.TRANSLATED,
  ],
  [WorkflowStatus.PUBLISHED]: [],
};

/** 检查 from → to 是否为合法转移。 */
export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 规范化状态字段值（从数据库读取时使用），
 * 未知值返回 null 而不是抛错，便于诊断脏数据。
 */
export function parseWorkflowStatus(value: string): WorkflowStatus | null {
  const match = Object.values(WorkflowStatus).find((status) => status === value);
  return match ?? null;
}

export function parseSourceStatus(value: string): SourceStatus | null {
  const match = Object.values(SourceStatus).find((status) => status === value);
  return match ?? null;
}
