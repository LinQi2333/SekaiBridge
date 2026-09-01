import { describe, expect, it } from 'vitest';
import { checkPermission, isAdminUser, isInAllowedGroup } from '../../../src/qq/permission.js';

const ADMIN = ['20001'];
const GROUPS = ['10001', '10002'];

describe('QQ 权限（规格 §41）', () => {
  it('管理员判定', () => {
    expect(isAdminUser('20001', ADMIN)).toBe(true);
    expect(isAdminUser('30001', ADMIN)).toBe(false);
  });

  it('群限制：配置了群白名单时只在允许群内放行', () => {
    expect(isInAllowedGroup('10001', GROUPS)).toBe(true);
    expect(isInAllowedGroup('99999', GROUPS)).toBe(false);
    expect(isInAllowedGroup(null, GROUPS)).toBe(false); // 私聊不视为群内
    // 未配置群白名单时不做限制
    expect(isInAllowedGroup(null, [])).toBe(true);
  });

  it('成员操作：允许群内普通成员', () => {
    const result = checkPermission({
      identity: { userId: '30001', groupId: '10001' },
      adminIds: ADMIN,
      groupIds: GROUPS,
      required: 'member',
    });
    expect(result.ok).toBe(true);
  });

  it('管理员操作：普通成员被拒，管理员通过', () => {
    const member = checkPermission({
      identity: { userId: '30001', groupId: '10001' },
      adminIds: ADMIN,
      groupIds: GROUPS,
      required: 'admin',
    });
    expect(member.ok).toBe(false);
    expect(member.reason).toContain('管理员');

    const admin = checkPermission({
      identity: { userId: '20001', groupId: '10001' },
      adminIds: ADMIN,
      groupIds: GROUPS,
      required: 'admin',
    });
    expect(admin.ok).toBe(true);
  });

  it('非允许群一律拒绝（即使是管理员）', () => {
    const result = checkPermission({
      identity: { userId: '20001', groupId: '99999' },
      adminIds: ADMIN,
      groupIds: GROUPS,
      required: 'admin',
    });
    expect(result.ok).toBe(false);
  });

  it('群主/群管理员自动视为管理员（无需在 QQ_ADMIN_IDS 中）', () => {
    const owner = checkPermission({
      identity: { userId: '30001', groupId: '10001', role: 'owner' },
      adminIds: ADMIN,
      groupIds: GROUPS,
      required: 'admin',
    });
    expect(owner.ok).toBe(true);

    const groupAdmin = checkPermission({
      identity: { userId: '30002', groupId: '10001', role: 'admin' },
      adminIds: ADMIN,
      groupIds: GROUPS,
      required: 'admin',
    });
    expect(groupAdmin.ok).toBe(true);

    // 普通成员仍被拒
    const member = checkPermission({
      identity: { userId: '30001', groupId: '10001', role: 'member' },
      adminIds: ADMIN,
      groupIds: GROUPS,
      required: 'admin',
    });
    expect(member.ok).toBe(false);
  });
});
