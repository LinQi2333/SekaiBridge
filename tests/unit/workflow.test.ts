import { describe, expect, it } from 'vitest';
import {
  canTransition,
  parseSourceStatus,
  parseWorkflowStatus,
  SourceStatus,
  WorkflowStatus,
} from '../../src/domain/workflow.js';

describe('workflow 状态机', () => {
  it('合法转移返回 true', () => {
    expect(canTransition(WorkflowStatus.DETECTED, WorkflowStatus.SCREENSHOT_READY)).toBe(true);
    expect(canTransition(WorkflowStatus.SCREENSHOT_READY, WorkflowStatus.QQ_SENT)).toBe(true);
    expect(canTransition(WorkflowStatus.QQ_SENT, WorkflowStatus.WAITING_TRANSLATION)).toBe(true);
    expect(canTransition(WorkflowStatus.WAITING_TRANSLATION, WorkflowStatus.TRANSLATED)).toBe(true);
    expect(canTransition(WorkflowStatus.TRANSLATED, WorkflowStatus.READY_TO_PUBLISH)).toBe(true);
    expect(canTransition(WorkflowStatus.READY_TO_PUBLISH, WorkflowStatus.PUBLISHING)).toBe(true);
    expect(canTransition(WorkflowStatus.PUBLISHING, WorkflowStatus.PUBLISHED)).toBe(true);
    expect(canTransition(WorkflowStatus.PUBLISHING, WorkflowStatus.PUBLISH_FAILED)).toBe(true);
    expect(canTransition(WorkflowStatus.PUBLISH_FAILED, WorkflowStatus.PUBLISHING)).toBe(true);
    // 翻译可以提前提交，也可以在发布失败后修订
    expect(canTransition(WorkflowStatus.DETECTED, WorkflowStatus.TRANSLATED)).toBe(true);
    expect(canTransition(WorkflowStatus.PUBLISH_FAILED, WorkflowStatus.TRANSLATED)).toBe(true);
  });

  it('非法转移返回 false', () => {
    expect(canTransition(WorkflowStatus.DETECTED, WorkflowStatus.PUBLISHED)).toBe(false);
    expect(canTransition(WorkflowStatus.WAITING_TRANSLATION, WorkflowStatus.PUBLISHING)).toBe(false);
    expect(canTransition(WorkflowStatus.PUBLISHED, WorkflowStatus.PUBLISHING)).toBe(false);
    expect(canTransition(WorkflowStatus.TRANSLATED, WorkflowStatus.TRANSLATED)).toBe(false);
  });

  it('状态解析', () => {
    expect(parseWorkflowStatus('TRANSLATED')).toBe(WorkflowStatus.TRANSLATED);
    expect(parseWorkflowStatus('NOPE')).toBeNull();
    expect(parseSourceStatus('SOURCE_DELETED')).toBe(SourceStatus.SOURCE_DELETED);
    expect(parseSourceStatus('NOPE')).toBeNull();
  });

  it('source 与 workflow 是两个独立维度（规格 §11 / §50 Case C、D）', () => {
    // 已翻译 + 原推已删除
    expect(parseWorkflowStatus('TRANSLATED')).toBeDefined();
    expect(parseSourceStatus('SOURCE_DELETED')).toBeDefined();
    // 已发布 + 原推已删除
    expect(parseWorkflowStatus('PUBLISHED')).toBeDefined();
    expect(parseSourceStatus('SOURCE_DELETED')).toBeDefined();
  });
});
