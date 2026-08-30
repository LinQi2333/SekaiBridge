# Twitter/X → QQ 翻译协作 → Bilibili 动态发布系统

> 完整实施规格见 `twitter_qq_bilibili_solution_v0.3.md`。

## 当前状态：全部阶段完成（Phase 1-10）

- [x] TypeScript 工程脚手架（ESM，Node.js 22+）
- [x] SQLite（WAL、foreign_keys=ON）+ 迁移机制（v1 init / v2 notifications）
- [x] Domain 模型（tweet / translation / topic / publish / workflow / notification）
- [x] Repository 层
- [x] Services 接口 + 核心服务实现
- [x] TweetToaster 客户端（`src/tweettoaster/`）
- [x] Monitor 监听（`SqliteMonitorService`）
- [x] 截图与媒体（Phase 4）
- [x] SOURCE_DELETED 来源检查（Phase 5）
- [x] HTTP API（Phase 6，NoneBot2 方案）
- [x] 翻译版本 / 话题 / 工作流（Phase 7）
- [x] Bilibili 发布（Phase 8）
- [x] Mock 全链路集成测试（Phase 9）
- [x] Docker / Health / README / 部署（Phase 10）
- [x] 单元测试 / 集成测试（160 个用例）

## 快速开始

```bash
npm install
cp .env.example .env        # 按需修改
npm run dev                 # tsx 运行 src/index.ts（含 HTTP API）
npm test                    # vitest 运行测试
npm run typecheck           # tsc --noEmit
npm run build               # 编译到 dist/
```

## 架构（NoneBot2 方案）

```text
Twitter/X → TweetToaster（数据 + 截图渲染）
                     ↓
            Node 主程序（本仓库）
              Monitor / 截图 / 媒体 / 来源检查 / 翻译 / 话题 / 发布
              HTTP API（:18080） + SQLite + 通知队列
                     ↑
         NoneBot2（Python，连 NapCat）——QQ 消息收发
             群成员 /翻译、/发布 等命令 → NoneBot2 插件 → HTTP API
```

QQ 层（NoneBot2）只做消息收发、命令解析、结果展示；
业务全部在 Node 的 Services 层，未来 Web 端复用同一套 API 与 Services。

## NoneBot2 插件接入

1. 配置 `.env`：`API_PORT`、`API_TOKEN`（与插件一致）、`QQ_GROUP_IDS`、`QQ_ADMIN_IDS`。
2. 每个请求带请求头：`X-API-Token`、`X-QQ-User`（QQ 号）、`X-QQ-Group`（群号）。
3. 新推文通知：轮询 `GET /api/notifications`，逐条发送（文本 + `screenshotPath` 图片
   + `videoThumbnails` 视频封面），成功后 `POST /api/notifications/:id/ack`。
4. 消息去重：处理命令前调用 `POST /api/messages/dedupe {message_id}`，返回
   `duplicate: true` 时直接忽略该条（§43）。
5. 命令与端点的对应见 `src/api/README.md`；`/查看` 的展示文本由 API 返回
   `format.view`，截图图片读取 `screenshotPath`（Node 与 NoneBot2 共享文件系统，
   或通过 `GET /api/tweets/:id` 返回的路径自行传输）。

## 目录

```text
src/
  config/       环境配置
  db/           SQLite + migrations
  domain/       领域模型与状态机
  repositories/ 数据访问
  services/     Application Services（QQ 与未来 Web 共用）
  qq/           QQ 权限与展示格式化（纯函数，NoneBot2 参考实现）
  tweettoaster/ TweetToaster 客户端与标准化
  media/        安全下载
  api/          HTTP API 服务
  bilibili/     后续阶段：Bilibili 客户端
tests/          单元 / 集成测试
data/           SQLite 文件（app.db）
cache/          截图 / 原始图片 / 视频封面缓存
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

## 部署（Docker Compose，规格 §58 / §62 Phase 10）

```bash
# 1. 配置（与仓库 .env.example 同名变量）
cp .env.example .env
#    填入：QQ_GROUP_IDS / QQ_ADMIN_IDS / BILI_SESSDATA / BILI_JCT / BILI_DEDEUSERID / API_TOKEN

# 2. 启动
docker compose up -d --build

# 3. 健康检查
curl http://127.0.0.1:18080/api/health
```

- 服务：`app`（本主程序）+ `tweettoaster`（官方镜像，数据 + 截图渲染）。
- QQ / NoneBot2 / NapCat 按部署环境独立运行，不在容器内（规格 §58）。
- 端口：API `127.0.0.1:18080`，TweetToaster `127.0.0.1:8082`（默认只监听本机）。

## 运维要点

- **数据库**：`data/app.db`（容器内 `/app/data/app.db`，volume `app-data`）。备份 = 拷贝该文件（建议停机或使用 SQLite backup；WAL 模式下同时保留 `app.db-wal`）。
- **缓存**：`cache/`（容器内 `/app/cache`，volume `app-cache`）：`screenshots/` 推文截图、`twitter-photos/` 原始图片、`video-thumbnails/` 视频封面。可安全清空（会按需重建）。
- **Bilibili Cookie 失效**（§54-18）：发布时返回 401 / `BILIBILI_AUTH`，推文进入 `PUBLISH_FAILED`；更新 `.env` 中的 `BILI_SESSDATA/BILI_JCT/BILI_DEDEUSERID` 后 `docker compose up -d` 重启，再 `/重试`。
- **SOURCE_DELETED 语义**（§12/§13）：只有单推检查明确 404 才标记"原推已删除"；本地翻译、话题、发布记录全部保留，不影响已发布动态，管理员仍可决定是否发布。
- **视频处理规则**（§18/§20/§22）：视频推文正常进 QQ 工作流，只下载默认封面；视频与封面都不上传 Bilibili，视频-only 推文发布为纯文本动态。
- **Secrets**：所有 Cookie / token 只来自环境变量，禁止写入 Git、源码、日志。

## 开发阶段

见规格 §62：P1 骨架 → P2 TweetToaster → P3 Monitor → P4 截图/媒体 →
P5 来源检查 → P6 QQ（NoneBot2 方案交付 HTTP API）→ P7 翻译/话题/工作流 →
P8 Bilibili → P9 集成测试 → P10 Docker/部署。**全部阶段已完成。**
