/**
 * 005_normalize_account_case：推文作者名统一小写。
 * 监听账号已小写规范化，而 TweetToaster 返回的 screenName 保留原始大小写，
 * 导致按账号查询（列表/查看/删除）大小写不匹配而查不到。
 */
export const up = `
UPDATE tweets SET author_screen_name = lower(author_screen_name);
`;
