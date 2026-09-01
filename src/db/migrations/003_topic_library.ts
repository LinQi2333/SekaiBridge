/**
 * 003_topic_library：话题改为"本地话题库 + 发布时指定"模型。
 * - 移除 tweets.topic_alias（推文不再单独绑定话题，话题只在发布时按别名指定）
 * - bili_topics 表（001 已建）即为话题库本体，无需改动
 */
export const up = `
ALTER TABLE tweets DROP COLUMN topic_alias;
`;
