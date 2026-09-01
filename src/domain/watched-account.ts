/** 监听账户（规格 §9）。 */
export interface WatchedAccount {
  id: number;
  screenName: string;
  enabled: boolean;
  bootstrapCompleted: boolean;
  /** 是否默认账号：列表/刷新等命令未指定账号时使用（全局唯一）。 */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
