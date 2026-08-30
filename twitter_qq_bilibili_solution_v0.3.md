# Twitter/X → QQ 翻译协作 → Bilibili 动态发布系统

> AI Coding Agent 实施规格  
> Version: 0.2  
> Status: MVP Specification  
> 核心工作平台：QQ  
> 未来扩展：网页端翻译/任务管理工具

---

# 0. 给 Coding Agent 的执行指令

你需要**实际实现本项目，而不是只分析需求或输出示例代码**。

开发时遵守以下原则：

1. 先完整阅读本文，再开始编码。
2. 参考并优先复用：
   - https://github.com/cn-matsuri/TweetToaster
3. 优先复用 TweetToaster 已有的：
   - Twitter/X 用户主页解析；
   - 推文获取；
   - FxTwitter / FxEmbed 数据源；
   - 推文结构标准化；
   - Chromium / Playwright 渲染；
   - 推文截图；
   - `/api/tweet`
   - `/api/render`
   - `/api/auto`
   - `/api/get_task=<id>`
4. **不要重新实现完整 Twitter 抓取器。**
5. TweetToaster 负责：
   - Twitter/X 数据读取；
   - 推文结构解析；
   - 推文截图。
6. 主项目负责：
   - 监听；
   - 持久化；
   - 推文编号；
   - QQ 工作流；
   - 翻译版本；
   - 话题；
   - Bilibili 发布；
   - 删除状态检查。
7. **QQ 是确定的主要工作平台。不要为了未来可能“替换 QQ”而设计抽象的聊天平台 Adapter。**
8. 但必须把核心业务逻辑从 QQ 命令处理器中分离出来，使未来网页端可以直接复用：
   - 推文查询；
   - 翻译提交；
   - 话题设置；
   - 发布；
   - 重试；
   - 状态查询。
9. QQ 与未来 Web 的关系应为：

```text
QQ Bot ───────┐
              │
Future Web ───┼──→ Application Services → Database / Bilibili / TweetToaster
              │
Other UI ─────┘
```

10. 不允许把业务逻辑直接写死在 QQ 消息事件回调中。
11. 所有业务状态必须持久化，不能只保存在内存。
12. 每完成一个阶段：
    - 运行测试；
    - 修复失败；
    - 再继续。
13. 外部平台不可用时：
    - 使用 Mock；
    - 继续完成核心逻辑。
14. 最终必须提供：
    - 可运行代码；
    - `.env.example`
    - SQLite migration；
    - Docker Compose；
    - README；
    - 单元测试；
    - 核心集成测试。
15. MVP 不引入 Redis、Kafka、Kubernetes、微服务等不必要复杂度。
16. 不实现 AI 翻译、AI 润色、自动话题推荐等功能。
17. 不实现 QQ 按钮式交互。
18. 不实现翻译认领、多人投票、校对审批等流程。
19. 群成员自行在 QQ 群内讨论，**只有最终确定后的翻译才通过 Bot 提交。**

---

# 1. 产品目标

构建一个以 QQ 群为主要工作空间的 Twitter/X → 人工翻译 → Bilibili 动态发布系统。

完整业务流程：

```text
Twitter/X
    ↓
监听指定账户
    ↓
检测新推文
    ↓
保存推文数据
    ↓
分配本地编号
    ↓
生成推文截图
    ↓
处理推文媒体
    ↓
发送到 QQ 群
    ↓
群成员讨论翻译
    ↓
通过 Bot 提交最终翻译
    ↓
可选设置 Bilibili 话题
    ↓
管理员确认发布
    ↓
翻译文本 + Twitter 原始图片
    ↓
Bilibili 动态
```

视频不转载到 Bilibili。

---

# 2. 核心平台边界

## 2.1 QQ

QQ 是本项目确定的工作平台，不考虑未来将 QQ 替换成 Discord、Telegram 等。

因此代码不需要：

```text
ChatPlatformAdapter
GenericMessagePlatform
AbstractBotProvider
```

这类为“换平台”而存在的过度抽象。

QQ 相关实现可以直接放在：

```text
src/qq/
```

但 QQ 层只负责：

```text
消息接收
命令解析
权限检查
结果格式化
图片发送
群消息发送
```

真正的业务操作必须调用 Application Service。

例如：

```text
QQ /翻译
    ↓
TranslationService.submit(...)
```

禁止：

```text
QQ /翻译
    ↓
直接 UPDATE translations ...
```

---

## 2.2 未来网页端

未来可能开发网页翻译工具，因此 MVP 就必须保证核心操作有稳定的内部接口。

至少应存在：

```text
TweetQueryService
TranslationService
TopicService
PublishService
WatchService
```

未来网页端只需要增加：

```text
HTTP API / Web UI
```

而不需要重写 QQ 业务逻辑。

未来 Web 可能调用：

```text
GET  /api/tweets
GET  /api/tweets/:id
POST /api/tweets/:id/translation
POST /api/tweets/:id/topic
POST /api/tweets/:id/publish
POST /api/tweets/:id/retry
```

MVP **不要求实现完整 Web UI**。

可以根据开发需要决定是否现在提供内部 HTTP API。

关键要求是：

> 核心业务服务不能依赖 QQ 消息格式。

---

# 3. 推荐技术栈

```text
Node.js 22+
TypeScript
SQLite
```

TweetToaster 独立运行。

推荐：

```text
Main App
TweetToaster
QQ / OneBot
```

部署时：

```text
Docker Compose
```

---

# 4. 总体架构

```text
                         ┌──────────────────┐
                         │    Twitter/X     │
                         └────────┬─────────┘
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │      TweetToaster        │
                    │ FxTwitter / FxEmbed      │
                    │ Tweet Parser             │
                    │ Chromium Renderer        │
                    └────────────┬─────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────┐
│                    Main Application                        │
│                                                            │
│  MonitorService                                            │
│  SourceValidationService                                   │
│  TweetQueryService                                         │
│  TranslationService                                        │
│  TopicService                                              │
│  PublishService                                            │
│  WorkflowService                                           │
│                                                            │
│                  ┌──────────────────┐                      │
│                  │      SQLite      │                      │
│                  └──────────────────┘                      │
│                                                            │
│        ▲                               │                   │
│        │                               ▼                   │
│   QQ Bot Commands               Bilibili Client            │
│                                                            │
│        ▲                                                   │
│        │                                                   │
│ Future Web API / Web UI  ← 复用同一套 Application Services │
└────────────────────────────────────────────────────────────┘
```

---

# 5. Twitter/X 监听

系统必须允许同时监听：

```text
0 个账户
1 个账户
N 个账户
```

0 个账户时应用必须继续正常运行：

```text
Application Running
QQ Bot Running
Database Running
Twitter Monitor Idle
```

监听账户必须支持：

- 添加；
- 删除；
- 开启；
- 关闭；
- 查看列表。

---

# 6. Polling

MVP 使用 polling。

默认：

```env
TWITTER_POLL_INTERVAL=60
```

单位为秒。

不同账户轮询加入少量随机 jitter：

```text
±10 seconds
```

避免所有请求同时发出。

---

# 7. 第一次监听账户

第一次添加账户时，不能把已有历史推文全部刷到 QQ 群。

默认：

```env
BOOTSTRAP_MODE=latest_only
```

流程：

```text
第一次读取 timeline
    ↓
将当前已有推文写入 seen / tweets
    ↓
标记 bootstrap 完成
    ↓
不发送 QQ 通知
```

之后检测到新推文才进入正式工作流。

---

# 8. 推文唯一性与编号

Twitter 原始 ID：

```text
x_tweet_id TEXT UNIQUE
```

本地任务编号：

```text
id INTEGER PRIMARY KEY AUTOINCREMENT
```

QQ群和未来 Web 默认使用本地编号：

```text
#152
#153
#154
```

Twitter Snowflake ID 只用于数据源识别和去重。

程序重启后：

```text
#152
```

必须仍然对应同一条推文。

---

# 9. watched_accounts

SQLite：

```text
id
screen_name
enabled
bootstrap_completed
created_at
updated_at
```

约束：

```text
screen_name UNIQUE
```

---

# 10. tweets

建议字段：

```text
id
x_tweet_id
author_screen_name
author_name
tweet_url
original_text
created_at_x
detected_at

raw_json
media_json

screenshot_path

workflow_status
source_status

last_error
retry_count

created_at
updated_at
```

约束：

```text
x_tweet_id UNIQUE
```

---

# 11. 工作流状态与来源状态分离

不要把 `SOURCE_DELETED` 和翻译/发布流程强行塞进同一个字段。

原因：

一条推文可能：

```text
已经翻译
但原推被删除
```

也可能：

```text
已经发布到 Bilibili
之后原推被删除
```

因此使用两个维度。

## workflow_status

```text
DETECTED
SCREENSHOT_READY
QQ_SENT
WAITING_TRANSLATION
TRANSLATED
READY_TO_PUBLISH
PUBLISHING
PUBLISHED
PUBLISH_FAILED
```

## source_status

```text
ACTIVE
SOURCE_DELETED
```

MVP 必须实现：

```text
SOURCE_DELETED
```

---

# 12. SOURCE_DELETED 检测

不能因为一条推文“没有出现在最近 timeline”就判定删除。

timeline 有长度限制，因此：

```text
not in timeline != deleted
```

正确方式：

对已经保存的推文按计划进行单推检查：

```text
getTweet(tweet_url)
```

如果 Provider 明确返回：

```text
404
tombstone
tweet not found
deleted
```

才设置：

```text
source_status = SOURCE_DELETED
```

推荐：

```env
SOURCE_CHECK_INTERVAL=1800
```

即 30 分钟检查一次。

MVP 可以优先检查：

```text
WAITING_TRANSLATION
TRANSLATED
READY_TO_PUBLISH
PUBLISH_FAILED
```

等仍在处理中的推文。

对于已经：

```text
PUBLISHED
```

可以低频检查或不主动持续检查，但 `/查看` 时允许进行一次刷新检查。

---

# 13. SOURCE_DELETED 后的数据处理

原推删除后：

**不得自动删除本地记录。**

保留：

```text
original_text
screenshot
media metadata
translation history
topic
publish record
```

如果尚未发布：

```text
source_status = SOURCE_DELETED
```

QQ `/查看` 明确显示：

```text
来源状态：原推已删除
```

默认仍允许管理员决定是否发布。

不要自动替用户决定：

```text
删除任务
取消翻译
删除 B站动态
```

---

# 14. TweetToaster 集成

优先把 TweetToaster 作为独立服务：

```env
TWEETTOASTER_URL=http://tweettoaster:8082
```

主程序调用：

```text
/api/tweet
/api/render
/api/auto
/api/get_task
```

不要重新实现 Twitter HTML 抓取。

---

# 15. 推文截图

新推文检测后生成 Twitter/X 推文截图。

截图用途：

```text
发送到 QQ 群
```

它与最终 Bilibili 上传的 Twitter 原图不是同一个资产。

必须明确：

```text
Tweet Screenshot
≠
Original Tweet Photo
```

---

# 16. Twitter 媒体分类

至少识别：

```text
photo
video
gif
```

保存：

```text
type
url
thumbnail_url
width
height
alt
```

---

# 17. QQ 中的图片推文

普通图片推文：

```text
推文截图
```

按现有产品流程发送到 QQ。

Twitter 原始图片仍需要单独保存/缓存，以供 Bilibili 发布时使用。

---

# 18. QQ 中的视频推文

**含视频推文同样必须进入 QQ 工作流。**

但是：

```text
不下载 Twitter 视频文件
不发送 Twitter 视频文件
```

对于视频媒体：

只下载其默认封面 / thumbnail。

例如：

```text
media.type = video
thumbnail_url = ...
```

QQ 中发送：

```text
【新推文 #152】

账号：@example
时间：2026-08-30 02:15
状态：待翻译

原推：
https://x.com/example/status/...

⚠️ 此推文包含视频。
以下图片为视频默认封面，不是普通推文图片。

[推文截图]
[视频默认封面]
```

**新推文通知中不要发送原文文本。**

如果推文包含多个视频媒体，可发送对应封面，但应避免重复 thumbnail。

如果 Provider 只提供一个视频封面，则发送一个。

---

# 19. 视频与图片混合推文的 QQ 表现

例如：

```text
photo A
video B
photo C
```

QQ：

```text
新推文通知
推文截图

⚠️ 此推文包含视频。
[video B 默认封面]
```

MVP 不要求额外把 photo A / C 原图全部发送 QQ。

如果未来需要可单独增加。

---

# 20. Bilibili 视频处理

强制规则：

# 视频不转载。

包括：

```text
video
gif / animated video
```

都不上传 Bilibili。

也不把视频默认封面当成普通 Twitter 图片上传 Bilibili。

---

# 21. Bilibili 图片处理

只上传：

```text
media.type == photo
```

例如：

```text
photo A
video B
photo C
```

最终 Bilibili：

```text
translation
photo A
photo C
```

忽略：

```text
video B
video B thumbnail
```

---

# 22. 视频-only 推文

Twitter：

```text
text
video
```

QQ：

```text
推文截图
视频默认封面
“此推文包含视频”
```

Bilibili：

```text
翻译文本
```

即纯文本动态。

---

# 23. QQ 作为工作平台

QQ 中完成：

```text
监听管理
任务查看
翻译提交
话题设置
发布
失败重试
```

不实现：

```text
翻译认领
多人投票
校对审批
按钮式交互
```

群成员自己在群里讨论最终翻译。

确定后由一名群员调用 `/翻译` 提交最终版本。

---

# 24. QQ 命令设计原则

不要使用：

```text
/tw watch add ...
/tw list pending ...
/tw show ...
/tw tr ...
```

这种所有功能挤在一个总命令下面的结构。

使用多个独立一级命令：

```text
/监听
/列表
/查看
/翻译
/话题
/发布
/重试
```

每个命令只处理一类逻辑。

参数只用于该命令自身的必要操作。

---

# 25. `/监听`

查看：

```text
/监听
```

返回：

```text
当前监听账户：

1. @foo    开启
2. @bar    开启
3. @test   关闭
```

添加：

```text
/监听 添加 @foo
```

开启：

```text
/监听 开启 @foo
```

关闭：

```text
/监听 关闭 @foo
```

删除：

```text
/监听 删除 @foo
```

监听修改默认只允许管理员。

---

# 26. `/列表`

默认：

```text
/列表
```

显示待处理任务。

例如：

```text
#155 @foo   待翻译
#154 @bar   已翻译
#153 @foo   原推已删除 / 待翻译
#152 @abc   发布失败
```

可选：

```text
/列表 待翻译
/列表 已翻译
/列表 已发布
/列表 失败
/列表 全部
```

分页：

```text
/列表 2
```

或者：

```text
/列表 待翻译 2
```

不要增加更多复杂参数。

---

# 27. `/查看`

单条：

```text
/查看 152
```

多条：

```text
/查看 152 155 160
```

或：

```text
/查看 152,155,160
```

返回：

```text
#152
@foo

来源状态：正常
工作状态：待翻译

原推：
https://x.com/...

[推文截图]
```

如果：

```text
source_status = SOURCE_DELETED
```

显示：

```text
来源状态：⚠️ 原推已删除
```

## QQ 中不重复发送原文正文

`/查看` 与新推文自动通知一样，**都不发送推文原文文本**。

Twitter/X 的内容展示统一依赖：

```text
推文截图
```

原因：

- 截图已经完整承担 Twitter/X 信息展示；
- 再发送 `original_text` 属于重复信息；
- 增加 QQ 消息长度；
- 增加网络流量和数据量；
- 长推文会显著增加群消息冗余；
- 截图能更稳定保留推文原始排版、emoji、引用结构和视觉信息。

数据库仍必须保存：

```text
original_text
```

因为它属于源数据，未来 Web 工具、检索、状态判断或其他内部功能可能使用。

但是 QQ 展示层默认不得输出它。

即：

```text
Database:
    original_text = 保存

QQ:
    original_text = 不发送
```

---

# 28. `/翻译`

格式：

```text
/翻译 152
这里是第一行翻译。
这里是第二行翻译！🌸
```

第一行：

```text
/翻译 <tweet_id>
```

其后的完整消息正文为翻译。

例如：

```text
/翻译 152
今天也辛苦啦～！🌸

晚上还有直播，
记得来看哦！✨
```

保存：

```text
换行
空行
emoji
Unicode
标点
URL
```

只允许规范化：

```text
\r\n → \n
```

禁止自动：

```text
删除 emoji
合并换行
润色
改写
繁简转换
AI 翻译
添加 hashtag
```

---

# 29. 翻译版本

建立：

```text
translations
```

字段：

```text
id
tweet_id
qq_user_id
text
version
created_at
```

后一次 `/翻译`：

```text
version += 1
```

最新版本为当前有效版本。

旧版本保留。

不需要：

```text
认领者
投票
reviewer
approval
```

---

# 30. 翻译提交后的 QQ 回复

例如：

```text
推文 #152 翻译已保存。

当前版本：v3
状态：已翻译，等待发布。

可继续：
/话题 152 hololive
/发布 152
```

---

# 31. Bilibili 话题

建立：

```text
bili_topics
```

字段：

```text
id
alias
bili_topic_id
name
enabled
created_at
```

例如：

```text
default     12345     夏色祭
hololive    23456     hololive
live        34567     VTuber直播
```

---

# 32. `/话题`

查看全部：

```text
/话题
```

返回：

```text
可用话题：

default    夏色祭
hololive   hololive
live       VTuber直播
```

给任务设置：

```text
/话题 152 hololive
```

取消：

```text
/话题 152 无
```

不实现：

```text
AI 自动话题推荐
自动猜测话题
```

---

# 33. `/发布`

默认人工确认：

```env
PUBLISH_MODE=manual
```

管理员：

```text
/发布 152
```

使用当前已保存话题。

也允许：

```text
/发布 152 hololive
```

含义：

```text
先设置话题
再发布
```

但主要推荐：

```text
/话题 152 hololive
/发布 152
```

职责更清晰。

---

# 34. 发布内容

Bilibili 动态：

```text
最终翻译文本
+
Twitter 原始 photo
+
可选 Bilibili 话题
```

不要默认追加：

```text
原推：
Twitter:
翻译：
搬运：
```

---

# 35. Bilibili 图片上传

流程：

```text
Twitter photo URL
    ↓
下载临时缓存
    ↓
Bilibili image upload
    ↓
获得 Bilibili 图片地址
    ↓
构建 pics[]
    ↓
发布动态
```

视频封面不得进入 `pics[]`。

---

# 36. Bilibili 发布服务

可以有平台 Client：

```text
src/bilibili/
```

例如：

```ts
class BilibiliClient {
    uploadImage(...)
    publishDynamic(...)
}
```

但是业务层调用应保持干净：

```ts
PublishService.publish(tweetId)
```

`PublishService` 负责：

```text
读取 tweet
读取最新 translation
读取 topic
筛选 photo
上传 photo
发布 dynamic
记录结果
```

QQ `/发布` 只调用：

```text
PublishService.publish(152)
```

未来 Web 也调用同一个方法。

---

# 37. 发布记录

```text
publish_records
```

字段：

```text
id
tweet_id
translation_id
bili_dynamic_id
bili_topic_id
status
attempt_count
last_error
created_at
published_at
```

关键原则：

```text
同一 tweet 默认只能成功发布一次
```

---

# 38. 幂等发布

如果：

```text
workflow_status = PUBLISHED
```

再次：

```text
/发布 152
```

不得再次调用 Bilibili API。

返回：

```text
#152 已发布。

Bilibili Dynamic ID:
xxxxxxxx
```

---

# 39. `/重试`

用于发布失败：

```text
/重试 152
```

只允许合法失败状态。

已经成功：

```text
PUBLISHED
```

则拒绝重复发布。

---

# 40. Bilibili 登录配置

只放 `.env`：

```env
BILI_SESSDATA=
BILI_JCT=
BILI_DEDEUSERID=
```

禁止写入：

```text
Git
源码
日志
错误消息
```

---

# 41. QQ 权限

```env
QQ_GROUP_IDS=
QQ_ADMIN_IDS=
```

普通群成员允许：

```text
/列表
/查看
/翻译
/话题
```

其中是否允许普通成员修改 `/话题` 可以配置。

管理员：

```text
/监听
/发布
/重试
```

---

# 42. QQ 新推文自动通知

格式：

```text
【新推文 #152】

账号：@example
时间：2026-08-30 02:15
状态：待翻译

原推：
https://x.com/example/status/...

[推文截图]
```

**不要包含原文正文。**

如果含视频：

```text
【新推文 #153】

账号：@example
时间：2026-08-30 02:20
状态：待翻译

原推：
https://x.com/example/status/...

⚠️ 此推文包含视频。
下方图片为视频默认封面，视频本体不会下载或转载。

[推文截图]
[视频默认封面]
```

---

# 43. QQ 消息去重

OneBot 事件可能重复。

保存：

```text
message_id
```

或实现持久化 dedupe。

避免：

```text
/发布 152
```

被重复执行。

---

# 44. 数据库

MVP：

```text
SQLite
```

路径：

```text
data/app.db
```

开启：

```text
WAL
foreign_keys = ON
```

使用 migration。

---

# 45. 推荐目录结构

```text
twitter-qq-bilibili/
│
├── src/
│   ├── index.ts
│   │
│   ├── config/
│   │   └── config.ts
│   │
│   ├── db/
│   │   ├── database.ts
│   │   └── migrations/
│   │
│   ├── domain/
│   │   ├── tweet.ts
│   │   ├── translation.ts
│   │   ├── topic.ts
│   │   ├── publish.ts
│   │   └── workflow.ts
│   │
│   ├── repositories/
│   │   ├── tweet-repository.ts
│   │   ├── translation-repository.ts
│   │   ├── watch-repository.ts
│   │   ├── topic-repository.ts
│   │   └── publish-repository.ts
│   │
│   ├── tweettoaster/
│   │   └── client.ts
│   │
│   ├── services/
│   │   ├── monitor-service.ts
│   │   ├── source-validation-service.ts
│   │   ├── tweet-query-service.ts
│   │   ├── screenshot-service.ts
│   │   ├── media-service.ts
│   │   ├── translation-service.ts
│   │   ├── topic-service.ts
│   │   ├── publish-service.ts
│   │   ├── watch-service.ts
│   │   └── workflow-service.ts
│   │
│   ├── qq/
│   │   ├── onebot-client.ts
│   │   ├── permission.ts
│   │   ├── router.ts
│   │   └── commands/
│   │       ├── watch.ts
│   │       ├── list.ts
│   │       ├── show.ts
│   │       ├── translate.ts
│   │       ├── topic.ts
│   │       ├── publish.ts
│   │       └── retry.ts
│   │
│   ├── bilibili/
│   │   ├── client.ts
│   │   ├── image-upload.ts
│   │   └── dynamic-publisher.ts
│   │
│   └── api/
│       └── README.md
│       # MVP 可以暂不启用 HTTP API，
│       # 但未来网页端应从这里接入同一套 Services。
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── mocks/
│
├── data/
├── cache/
│   ├── screenshots/
│   ├── twitter-photos/
│   └── video-thumbnails/
│
├── .env.example
├── .gitignore
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

---

# 46. `.env.example`

```env
NODE_ENV=production

DATABASE_PATH=./data/app.db

TWEETTOASTER_URL=http://tweettoaster:8082
TWITTER_POLL_INTERVAL=60
SOURCE_CHECK_INTERVAL=1800
BOOTSTRAP_MODE=latest_only

ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=

QQ_GROUP_IDS=
QQ_ADMIN_IDS=

BILI_SESSDATA=
BILI_JCT=
BILI_DEDEUSERID=

PUBLISH_MODE=manual
```

---

# 47. 媒体缓存

```text
cache/screenshots/<tweet-id>.png
cache/twitter-photos/<tweet-id>/<index>.<ext>
cache/video-thumbnails/<tweet-id>/<index>.<ext>
```

明确区分：

```text
screenshot
photo
video thumbnail
```

三种资产。

---

# 48. 媒体安全

远程下载：

- timeout；
- 最大文件大小；
- 只允许 HTTP / HTTPS；
- 验证 Content-Type；
- 图片格式白名单；
- 禁止 `file://`；
- 禁止任意本地路径读取；
- 不执行媒体内容。

---

# 49. 文本格式

整个项目：

```text
UTF-8
```

必须测试：

```text
中文
日本語
English
🌸
😭
🥹
❤️
✨
颜文字
多行
空行
URL
```

QQ：

```text
/翻译
```

到 SQLite，再到 Bilibili payload，内容必须保持一致。

---

# 50. SOURCE_DELETED MVP 测试

必须加入：

## Case A：单推明确 404

```text
Given:
    tweet #152 exists

When:
    source checker calls getTweet()
    provider returns tweet-not-found

Then:
    source_status = SOURCE_DELETED
```

## Case B：timeline 中消失但单推仍存在

```text
Given:
    tweet #152 not in latest timeline

When:
    getTweet(#152) succeeds

Then:
    source_status remains ACTIVE
```

## Case C：已经翻译后删除

```text
workflow_status = TRANSLATED
source_status = SOURCE_DELETED
```

两个状态同时成立。

## Case D：已经发布后删除

```text
workflow_status = PUBLISHED
source_status = SOURCE_DELETED
```

不得自动删除 Bilibili 动态。

---

# 51. QQ 文本冗余测试

## 新推文自动通知

自动通知 payload 不能出现：

```text
original_text
```

必须包含：

```text
local id
account
time
status
tweet URL
screenshot
```

## `/查看`

`/查看 152` 的 QQ 输出同样不能包含：

```text
original_text
```

必须通过：

```text
tweet screenshot
```

展示 Twitter/X 内容。

数据库中的 `original_text` 不受影响，仍正常持久化。

---

# 52. 视频 QQ 测试

Twitter：

```text
text
video
```

QQ 必须：

```text
发送推文截图
发送 video thumbnail
发送“此推文包含视频”提示
```

必须断言：

```text
downloadVideo() never called
sendVideo() never called
```

---

# 53. 视频 Bilibili 测试

Twitter：

```text
photo A
video B
photo C
```

最终：

```text
uploadImage(A)
uploadImage(C)
```

不得：

```text
upload video B
upload thumbnail B
```

---

# 54. 其他核心测试

必须覆盖：

1. 0 个监听账户；
2. 1 个监听账户；
3. N 个监听账户；
4. bootstrap 不刷历史推文；
5. x_tweet_id 去重；
6. 程序重启编号不变；
7. `/列表`；
8. `/查看 152`；
9. `/查看 152,154`；
10. `/翻译` 保留 emoji / 换行；
11. 翻译版本历史；
12. `/话题`；
13. 图片上传；
14. 视频排除；
15. 视频封面 QQ 通知；
16. Bilibili 发布；
17. 重复发布保护；
18. Cookie 过期；
19. `/重试`；
20. SOURCE_DELETED；
21. QQ message_id 去重；
22. Future Web 可以直接调用 Services，而不依赖 QQ command parser。

---

# 55. Mock

测试不依赖真实：

```text
Twitter
QQ
Bilibili
```

建议：

```text
MockTweetToasterClient
MockQQClient
MockBilibiliClient
```

注意：

QQ 不需要设计成“未来可替换聊天平台 Adapter”。

Mock 只是为了测试 QQ 发送行为。

---

# 56. 日志

至少：

```text
tweet.detected
tweet.duplicate
tweet.screenshot.complete

tweet.source.active
tweet.source.deleted

tweet.video.detected
tweet.video.thumbnail.downloaded

qq.message.received
qq.notification.sent

translation.created
translation.updated

bilibili.upload.complete
bilibili.publish.started
bilibili.publish.complete
bilibili.publish.failed
```

禁止打印 secrets。

---

# 57. Health Check

```http
GET /health
```

例如：

```json
{
  "status": "ok",
  "database": "ok",
  "tweettoaster": "ok",
  "qq": "connected"
}
```

---

# 58. Docker Compose

至少：

```text
app
tweettoaster
```

QQ/NapCat 根据部署环境决定是否独立运行。

不要把 QQ 客户端强制塞进主应用容器。

---

# 59. README

必须包含：

```text
项目用途
架构
TweetToaster
QQ / OneBot 配置
Bilibili 配置
启动方法

/监听
/列表
/查看
/翻译
/话题
/发布
/重试

数据库位置
缓存位置
备份
SOURCE_DELETED 语义
视频处理规则
Cookie 失效处理
未来 Web 接入方式
```

---

# 60. 明确不实现

MVP 和可预见未来都不需要主动规划以下功能：

```text
翻译认领
多人翻译投票
校对审批流
AI 自动翻译
AI 翻译建议
AI 润色
AI 自动话题推荐
QQ 按钮式交互
Discord / Telegram 替换 QQ
Twitter 视频转载
Bilibili 视频投稿
```

不要为这些需求提前增加复杂抽象。

---

# 61. 未来允许扩展

目前只需要为以下真正可能的扩展留好结构：

```text
1. Web 翻译工具

2. Web 任务列表

3. Web 查看推文详情

4. Web 提交最终翻译

5. Web 设置 Bilibili 话题

6. Web 发布 / 重试

7. 每个 Twitter 账号设置默认 Bilibili 话题

8. 不同 Twitter 账号通知不同 QQ 群

9. 多 Bilibili 账号（仅保留结构可能性，不做 MVP）

10. 定时发布

11. 发布队列

12. Reply / Quote / Retweet 独立过滤规则

13. 推文删除状态持续检查

14. 操作审计日志
```

Web 端未来必须复用：

```text
TweetQueryService
TranslationService
TopicService
PublishService
```

而不是通过模拟 QQ 命令实现。

---

# 62. 开发阶段

## Phase 1

```text
Project scaffold
TypeScript
SQLite
Migration
Repository
Domain
Services interface
Tests
```

---

## Phase 2

```text
TweetToaster Client
timeline
single tweet
render
media normalization
```

---

## Phase 3

```text
Monitor
bootstrap
dedupe
local id
```

---

## Phase 4

```text
Screenshot
photo cache
video thumbnail cache
video detection
```

---

## Phase 5

```text
SOURCE_DELETED checker
source_status
```

---

## Phase 6

```text
QQ OneBot

/监听
/列表
/查看
/翻译
/话题
/发布
/重试
```

---

## Phase 7

```text
Translation versioning
Topic
Workflow
```

---

## Phase 8

```text
Bilibili image upload
Dynamic publish
Idempotency
Retry
```

---

## Phase 9

完整集成测试：

```text
Mock Twitter
    ↓
new tweet
    ↓
screenshot
    ↓
video thumbnail if needed
    ↓
Mock QQ
    ↓
final translation
    ↓
topic
    ↓
publish
    ↓
Mock Bilibili
```

---

## Phase 10

```text
Docker
Health
README
Deployment
```

---

# 63. MVP 完成标准

- [ ] 可以运行；
- [ ] 监听账户数量允许 0 / 1 / N；
- [ ] 第一次监听不刷历史消息；
- [ ] 推文唯一去重；
- [ ] 每条推文获得稳定本地编号；
- [ ] 重启不丢任务；
- [ ] 自动生成推文截图；
- [ ] 自动发送 QQ；
- [ ] 自动通知不包含原文正文；
- [ ] 图片推文正常进入 QQ；
- [ ] 视频推文正常进入 QQ；
- [ ] 视频只下载默认封面；
- [ ] QQ 明确标注“包含视频”；
- [ ] 不下载视频本体；
- [ ] `/监听` 可管理账户；
- [ ] `/列表` 可查看任务；
- [ ] `/查看` 可查看一个或多个编号；
- [ ] `/查看` 不重复发送原文正文，只展示状态、原推链接与推文截图；
- [ ] `/翻译` 可提交最终翻译；
- [ ] 翻译保留换行与 emoji；
- [ ] 翻译保留版本历史；
- [ ] `/话题` 可设置或取消话题；
- [ ] `/发布` 可人工发布；
- [ ] Bilibili 只上传 photo；
- [ ] video 不转载；
- [ ] video thumbnail 不上传 Bilibili；
- [ ] video-only 推文可以发纯文本动态；
- [ ] 同一推文不会重复发布；
- [ ] 发布失败可重试；
- [ ] Bilibili 登录失效可正确报错；
- [ ] `SOURCE_DELETED` 已实现；
- [ ] 原推删除不会丢本地翻译和发布记录；
- [ ] QQ Bot 业务逻辑通过 Services 实现；
- [ ] Future Web 可复用 Services；
- [ ] 无 AI 翻译相关代码；
- [ ] 无翻译认领/投票/校对流程；
- [ ] 无 QQ 按钮式交互；
- [ ] secrets 不进入 Git；
- [ ] 自动测试通过；
- [ ] Docker Compose 可启动核心服务；
- [ ] README 完整。

---

# 64. 最重要的业务约束

```text
① QQ 是确定的主要工作平台，不为替换 QQ 做过度抽象。

② 未来 Web 需要复用核心 Application Services。

③ 新推文 QQ 自动通知不显示原文正文。

④ `/查看` 同样不显示原文正文，Twitter/X 内容统一通过推文截图展示。

⑤ QQ 命令使用多个独立一级命令：
   /监听 /列表 /查看 /翻译 /话题 /发布 /重试

⑥ 群成员自行讨论翻译，Bot 只接收最终版本。

⑦ 不做翻译认领、投票、校对审批。

⑧ 不做任何 AI 翻译、AI 润色、AI 话题推荐。

⑨ 不做 QQ 按钮交互。

⑩ 视频推文必须进入 QQ 工作流。

⑪ 视频不下载本体，只下载默认封面，并明确标注“包含视频”。

⑫ 视频和视频封面都不上传 Bilibili。

⑬ Bilibili 只上传 Twitter 原始 photo。

⑭ SOURCE_DELETED 是 MVP 必须状态。

⑮ source_status 和 workflow_status 必须分离。

⑯ 不因 timeline 中消失就判定 SOURCE_DELETED。

⑰ 原推删除后本地记录仍保留。

⑱ Twitter ID 与本地编号分离。

⑲ x_tweet_id 必须数据库唯一。

⑳ 程序重启不能丢任务或改变编号。

㉑ 同一推文不能重复发布。

㉒ 翻译必须保留 Unicode、emoji、换行和空行。

㉓ 所有 secret 来自环境变量。
```

---

# 65. 开始执行

先检查 TweetToaster 当前实现：

```text
/api/tweet
/api/render
/api/auto
/api/get_task
provider response
media.type
video thumbnail field
Chromium renderer
```

重点确认：

1. 是否可以稳定区分：

```text
photo
video
gif
```

2. video 是否能够得到：

```text
thumbnail_url
```

3. `/api/render` 是否能生成适合直接发送 QQ 的推文截图。

如果截图接口当前会强制加入翻译模板、Logo 或其他不需要的内容：

**不要重写整个截图系统。**

在 TweetToaster 中以最小修改增加：

```text
original-only render mode
```

或者：

```text
/api/screenshot
```

然后开始 Phase 1，一直实现到 MVP 测试通过。
