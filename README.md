# SekaiBridge（世界桥）

PJSK 推文搬运系统：监听 Twitter/X 账号 → 新推文截图并通知 QQ 群 → 群成员协作翻译 → 管理员发布到 Bilibili 动态（原图 + 话题）。

面向 **Linux + Docker** 部署。

---

## 架构

```text
Twitter/X ──► tweettoaster（截图/数据）──► app（Node + SQLite，HTTP API :18080）
                                                  │
QQ 群 ◄──► nonebot2（QQ 命令）◄── napcat（Linux QQ / OneBot）
                                                  │
                                               Bilibili（发布动态）
```

两个部署形态：

- **全栈（推荐，开箱即用）**：`napcat` + `nonebot2` 也走 Docker，一条 `./start.sh` 全部拉起
- **已有裸机 NapCat/NoneBot2**：只跑 `app` + `tweettoaster`（QQ 侧配置指向主程序 HTTP API 即可）

---

## 快速开始（全栈，Linux + Docker Compose v2）

```bash
git clone https://github.com/LinQi2333/SekaiBridge.git /opt/sekai-bridge
cd /opt/sekai-bridge
cp .env.example .env
vim .env        # 必填：QQ_GROUP_IDS / QQ_ADMIN_IDS / API_TOKEN / BILI_COOKIE_STRING
./start.sh      # 构建并启动全部 4 个服务
./start.sh status
```

启动后登录机器人 QQ：浏览器打开 `http://<服务器IP>:6099/webui`（token 见 `docker compose logs napcat`）扫码登录。

验证：`curl http://127.0.0.1:18080/api/health` 返回 `{"ok":true,...}`；群里发 `/列表` 有响应即全链路通了。

> 命令前缀默认 `/`，可在 NoneBot2 侧 `COMMAND_START` 调整（如改为 `!`）。

---

## .env 配置

| 变量 | 说明 |
| --- | --- |
| `QQ_GROUP_IDS` | 允许使用的 QQ 群号，逗号分隔（必填） |
| `QQ_ADMIN_IDS` | 管理员 QQ 号，逗号分隔（必填；群主/群管理员自动拥有管理权限） |
| `API_TOKEN` | 内部 API 密钥，`openssl rand -hex 32` 生成（必填） |
| `BILI_COOKIE_STRING` | Bilibili 发布账号完整 Cookie 串（推荐；见下） |
| `BILI_SESSDATA` / `BILI_JCT` / `BILI_DEDEUSERID` | 未提供完整串时的最小三件套（可选） |
| `BILI_COOKIE_FILE` | Cookie 持久化文件路径（默认数据库同目录，自动续期写回） |
| `TWITTER_POLL_INTERVAL` | 监听轮询间隔（秒，默认 60） |
| `HTTPS_PROXY` / `HTTP_PROXY` | 可选代理：访问 Twitter 图床被墙时配置 |

其余变量（端口、轮询等）可留默认，详见 `.env.example`。

### Bilibili Cookie

1. 浏览器（建议隐私窗口，与日常登录隔离）登录 `https://www.bilibili.com`
2. `F12` → 存储/Application → Cookies，把登录后产生的 cookie 逐条复制为
   `SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx; buvid3=xxx; ...` 填入 `BILI_COOKIE_STRING`
3. 验证：`docker compose up -d app` 后看启动日志；或调用 nav 查询确认 `isLogin: true`

主程序会**自动续期 `bili_ticket`**（浏览器同款机制）并把新值写回 Cookie 文件；
`SESSDATA` 临近过期时会输出预警日志，按提示重新复制 Cookie 即可。

---

## QQ 群命令

| 命令 | 权限 | 说明 |
| --- | --- | --- |
| `/监听` | 管理员 | 监听账户列表（⭐ 默认账号） |
| `/监听 默认 @账号` | 管理员 | 设为默认账号（首个添加的账号自动默认） |
| `/监听 添加/开启/关闭/删除 @账号` | 管理员 | 管理监听（删除会清空该账号历史推文） |
| `/列表 [状态] [页码] [@账号]` | 成员 | 任务列表；状态：待翻译/已翻译/已发布/失败/全部（默认全部） |
| `/查看 <编号> [@账号]` | 成员 | 推文状态 + 原推链接 + 截图 |
| `/翻译 <编号> [@账号]` | 成员 | 提交翻译（第二行起为正文） |
| `/话题 <话题号> <别名>` | 管理员 | 添加话题到库；`/话题` 查看库；`/话题 删除 <别名>` |
| `/发布 <编号> [别名]` | 管理员 | 发布到 Bilibili（翻译 + 原图 + 话题） |
| `/重试 <编号> [@账号]` | 管理员 | 发布失败后重试 |
| `/刷新 [@账号]` | 管理员 | 立即轮询一次 |

- 编号为**账号内独立编号**；未指定账号的命令作用于默认账号
- 新推文自动通知群（含截图；视频推文仅封面），不含原文正文

---

## 运维

```bash
./start.sh status      # 服务状态 + 健康检查
./start.sh logs [svc]  # 跟随日志
./start.sh stop        # 停止（保留数据）
./start.sh restart
./start.sh down        # 停止并删除容器（数据卷保留）
```

- **更新**：`git pull && ./start.sh`
- **数据**：数据库在 volume `app-data`（`/app/data/app.db`）；媒体缓存在 `cache/`（与宿主机同路径挂载，可安全清空）
- **发布失败**：`/发布` 返回 `BILIBILI_AUTH` → Cookie 失效 → 重新复制 `BILI_COOKIE_STRING` → `docker compose up -d app` → `/重试`
- **Bilibili 必须直连**（勿为其配置代理，会触发 CSRF/风控）；Twitter 媒体如需代理配 `HTTPS_PROXY`

---

## 目录

```text
src/              主程序（TypeScript）
  config/ db/ domain/ repositories/ services/
  tweettoaster/ media/ api/ bilibili/
nonebot-plugin/   NoneBot2 插件（QQ 命令与通知）
docker-compose.yml 全栈编排（QQ 侧在 profile "full" 下）
start.sh         一键启动/状态/日志/停止
.env.example     环境变量模板
```
