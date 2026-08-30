# Twitter/X → QQ 翻译协作 → Bilibili 动态发布系统

> 完整实施规格见 `twitter_qq_bilibili_solution_v0.3.md`。

## 当前状态：Phase 4（截图与媒体缓存）

- [x] TypeScript 工程脚手架（ESM，Node.js 22+）
- [x] SQLite（WAL、foreign_keys=ON）+ 迁移机制
- [x] Domain 模型（tweet / translation / topic / publish / workflow）
- [x] Repository 层
- [x] Services 接口 + 核心服务实现
- [x] TweetToaster 客户端（`src/tweettoaster/`）
- [x] Monitor 监听（`SqliteMonitorService`）
- [x] 截图与媒体（Phase 4）
  - `DefaultScreenshotService`：TweetToaster render（original-only）→ 下载到 `cache/screenshots/<tweet-id>.png`
  - `DefaultMediaService`：photo → `cache/twitter-photos/`，视频封面 → `cache/video-thumbnails/`（三种资产分离，§47）
  - 视频只下载默认封面，不下载视频本体（§18/§20）
  - `safeDownload` 安全下载：HTTP/HTTPS 白名单、超时、大小上限、Content-Type 白名单（§48）
  - `DefaultNewTweetProcessor`：新推文 → 截图 → `SCREENSHOT_READY` → 媒体缓存（失败不阻塞）
- [x] 单元测试 / 集成测试（98 个用例）

## 快速开始

```bash
npm install
cp .env.example .env        # 按需修改
npm run dev                 # tsx 运行 src/index.ts
npm test                    # vitest 运行测试
npm run typecheck           # tsc --noEmit
npm run build               # 编译到 dist/
```

## 目录

```text
src/
  config/      环境配置
  db/          SQLite + migrations
  domain/      领域模型与状态机
  repositories/ 数据访问
  services/    Application Services（QQ 与未来 Web 共用）
  qq/          后续阶段：QQ / OneBot
  bilibili/    后续阶段：Bilibili 客户端
  api/         预留 HTTP API 说明
tests/         单元 / 集成测试
data/          SQLite 文件（app.db）
cache/         截图 / 原始图片 / 视频封面缓存
```

## 核心约定

- 本地编号（#152）与 Twitter Snowflake ID 分离；`x_tweet_id` 数据库唯一。
- `workflow_status` 与 `source_status` 两个维度分离（可"已发布但原推已删除"）。
- 原推删除由单推检查明确确认，不因"不在 timeline"判定。
- QQ 新推文通知与 `/查看` 都不发送原文正文，内容统一由推文截图展示。
- 翻译只做 `\r\n → \n` 规范化，保留 emoji / 换行 / 空行；保留版本历史。
- 视频不下载本体、不上传 Bilibili；Bilibili 只上传 `photo`。
- 同一推文只能成功发布一次（数据库级唯一约束保证幂等）。
- 所有 secret 来自环境变量，禁止进入 Git / 日志。

## 开发阶段

见规格 §62：P1 骨架 → P2 TweetToaster → P3 Monitor → P4 截图/媒体 →
P5 来源检查 → P6 QQ → P7 翻译/话题/工作流 → P8 Bilibili → P9 集成测试 → P10 Docker/部署。
