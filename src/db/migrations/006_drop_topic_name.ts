/**
 * 006_drop_topic_name：话题库移除 name 字段。
 * B 站按话题号挂话题，name 仅展示且无法可靠反查，直接删除。
 */
export const up = `
ALTER TABLE bili_topics DROP COLUMN name;
`;
