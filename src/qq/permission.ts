/**
 * QQ 权限判定（规格 §41）。
 * 纯函数，不依赖 QQ 消息格式；NoneBot2 通过 HTTP API 传入身份后由 API 层调用。
 *
 * 普通群成员允许：/列表 /查看 /翻译 /话题
 * 管理员：/监听 /发布 /重试
 */
export interface QqIdentity {
  /** QQ 号（字符串，避免大数精度问题）。 */
  userId: string;
  /** 消息所在群号；null 表示私聊等非群场景。 */
  groupId: string | null;
}

export type QqPermission = 'member' | 'admin';

export interface PermissionCheckOptions {
  identity: QqIdentity;
  adminIds: string[];
  groupIds: string[];
}

export interface PermissionResult {
  ok: boolean;
  reason: string | null;
}

export function isAdminUser(userId: string, adminIds: string[]): boolean {
  return adminIds.includes(userId);
}

export function isInAllowedGroup(groupId: string | null, groupIds: string[]): boolean {
  // 未配置 QQ_GROUP_IDS 时不做群限制（方便调试）
  if (groupIds.length === 0) return true;
  return groupId !== null && groupIds.includes(groupId);
}

/**
 * 校验身份与权限。
 * - 群不在允许列表（且配置了群限制）→ 拒绝；
 * - 请求 admin 权限但用户不在管理员列表 → 拒绝。
 */
export function checkPermission(
  options: PermissionCheckOptions & { required: QqPermission },
): PermissionResult {
  const { identity, adminIds, groupIds, required } = options;
  if (!isInAllowedGroup(identity.groupId, groupIds)) {
    return { ok: false, reason: '该 QQ 群不在允许列表中' };
  }
  if (required === 'admin' && !isAdminUser(identity.userId, adminIds)) {
    return { ok: false, reason: '需要管理员权限' };
  }
  return { ok: true, reason: null };
}
