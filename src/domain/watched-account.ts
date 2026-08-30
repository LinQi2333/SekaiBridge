/** 监听账户（规格 §9）。 */
export interface WatchedAccount {
  id: number;
  screenName: string;
  enabled: boolean;
  bootstrapCompleted: boolean;
  createdAt: string;
  updatedAt: string;
}
