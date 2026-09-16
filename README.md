# SekaiBridge（世界桥）

PJSK 推文搬运系统：监听 Twitter/X 账号 → 新推文截图并通知 QQ 群 → 群成员协作翻译 → 管理员发布到 Bilibili 动态（原图 + 话题）。

本项目部分内容由deepseek-v4-flash/deepseek-v4.1-flash编写

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
| `BILI_REFRESH_TOKEN` | 持久化刷新口令（`ac_time_value`）：配置后 `SESSDATA` 自动续期（见下） |
| `BILI_SESSDATA` / `BILI_JCT` / `BILI_DEDEUSERID` | 未提供完整串时的最小三件套（可选） |
| `BILI_COOKIE_FILE` | Cookie 持久化文件路径（默认数据库同目录，自动续期写回） |
| `TWITTER_POLL_INTERVAL` | 监听轮询间隔（秒，默认 60） |
| `MEDIA_CACHE_TTL_DAYS` | 媒体缓存保留天数（默认 7；截图不受影响） |
| `MEDIA_EXPORT_MAX_MB` | 单个媒体文件下载上限（MB，默认 300） |
| `MAX_GROUP_FILE_MB` | QQ 群文件上限（MB，默认 100；超过则不上传并提示） |
| `HTTPS_PROXY` / `HTTP_PROXY` | 可选代理：访问 Twitter 图床被墙时配置 |

其余变量（端口、轮询等）可留默认，详见 `.env.example`。

### Bilibili Cookie

**方式一：从浏览器复制**（需要能开浏览器）

1. 浏览器（建议用一个**专用配置文件**，不要用无痕窗口——无痕关闭后 localStorage 会被清空，
   `ac_time_value` 就取不回来了）登录 `https://www.bilibili.com`
2. `F12` → 存储/Application → Cookies，把登录后产生的 cookie 逐条复制为
   `SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx; buvid3=xxx; ...` 填入 `BILI_COOKIE_STRING`
   （也可以从 Network → 任一 `www.bilibili.com` 请求的 Request Headers 里整行复制 `cookie:`，
   注意 `document.cookie` 取不到 HttpOnly 的 `SESSDATA`）
3. 同一面板 → Local Storage → `https://www.bilibili.com` → 复制 `ac_time_value` 填入
   `BILI_REFRESH_TOKEN`（B 站官方的持久化刷新口令，是 `SESSDATA` 自动续期的前提）
4. 验证：`docker compose up -d app` 后看启动日志；或调用 nav 查询确认 `isLogin: true`

**方式二：扫码登录（推荐，服务器上直接完成，无需浏览器插件/DevTools）**

```bash
cd /opt/sekai-bridge
git pull
docker compose stop app                                   # 先停 app，避免它把旧 cookie 写回文件
docker compose --profile tools run --rm --build --service-ports bili-login
#   → 浏览器打开 http://<服务器IP>:18081/ ，用手机 B 站 App 扫码并在手机上确认
docker compose up -d app
docker compose logs -f app | grep -i bilibili
```

- 二维码三种给法：**网页**（NapCat 式，失败会自动刷新二维码）、**终端里直接打印**（网页打不开时用）、
  以及 PNG `cache/bili-login-qr.png`；网页打不开通常是云服务器安全组没放行 18081（临时放行即可，
  容器退出后端口自动释放）
- 扫码成功后工具会核对账号昵称，并把新 Cookie **直接写进 app 的数据卷**
  （`/app/data/bili-cookies.json`），所以**不用改 `.env`**；同时也会打印两行 `.env` 片段
  （建议顺手更新 `.env` 作为兜底：app 读文件优先，文件丢了才会回退 `.env`）
- 不想要网页时（只打印终端二维码与 PNG）：把命令末尾换成完整脚本调用
  `docker compose --profile tools run --rm --service-ports bili-login node scripts/bili-login.mjs --no-serve`

**方式二（本机版）**：没有 Docker 环境时可在本地电脑跑同一脚本，再把结果填进服务器 `.env`：

```bash
npm install            # 首次：安装二维码依赖 qrcode
npm run bili:login     # 终端二维码 + 本地网页 http://127.0.0.1:18081 + bili-login-qr.png
```

成功后脚本输出 `BILI_COOKIE_STRING` 与 `BILI_REFRESH_TOKEN`，并写入 `bili-login.env`
（**含凭据，贴完请删除**）。常用参数：`--no-serve`、`--host=0.0.0.0`、`--out=<png路径>`、
`--cookie-file=<路径>`（直接写 app 的 cookie 文件）。

**改用 .env 方式时**（方式一，或本机版脚本）：

```bash
cd /opt/sekai-bridge
vim .env        # 覆盖 BILI_COOKIE_STRING，填好 BILI_REFRESH_TOKEN
docker compose up -d --build app
docker compose exec app rm -f /app/data/bili-cookies.json   # 清掉旧 cookie 文件，避免覆盖 .env
docker compose restart app
docker compose logs -f app | grep -i bilibili
```

主程序每 6 小时做一次会话体检与自动续期（B 站 Web 端同款机制）：

- **`bili_ticket`**：始终自动续期（有效期 3 天），新值写回 Cookie 文件
- **`SESSDATA`**：B 站提示临近过期时自动续期（`cookie/info` → CorrespondPath →
  `refresh_csrf` → `cookie/refresh` → `confirm/refresh`），新 Cookie 与**轮换后的
  `ac_time_value`** 一起写回 Cookie 文件，因此只需配置一次
- 续期成功日志：`[bilibili] SESSDATA 已自动续期，有效期至 ...`
- 续期失败（如口令被作废 `code=86095`、被风控）会打印原因：程序遇到 86095 会自动改用
  `.env` 里的 `BILI_REFRESH_TOKEN`；若仍失败，重新复制 Cookie 与 `ac_time_value` 后
  删除 Cookie 文件再重启：`docker compose exec app rm -f /app/data/bili-cookies.json`
- 未配置 `BILI_REFRESH_TOKEN` 时行为与旧版一致：只预警，需人工更新 Cookie

> 续期不等于永久免维护：账号被风控强制下线、改密码、或长期未登录时仍需重新登录一次。

---

## QQ 群命令

| 命令 | 权限 | 说明 |
| --- | --- | --- |
| `/监听` | 管理员 | 监听账户列表（⭐ 默认账号） |
| `/监听 默认 @账号` | 管理员 | 设为默认账号（首个添加的账号自动默认） |
| `/监听 添加/开启/关闭/删除 @账号` | 管理员 | 管理监听（删除会清空该账号历史推文） |
| `/列表 [状态] [页码] [@账号]` | 成员 | 任务列表；状态：待翻译/已翻译/已发布/失败/全部（默认全部） |
| `/查看 <编号> [@账号]` | 成员 | 推文状态 + 原推链接 + 截图 |
| `/媒体 <编号> [@账号]` | 成员 | 下载推文原图与视频（最高画质）并上传到群文件 |
| `/翻译 <编号> [@账号]` | 成员 | 提交翻译（第二行起为正文） |
| `/话题 <话题号> <别名>` | 管理员 | 添加话题到库；`/话题` 查看库；`/话题 删除 <别名>` |
| `/发布 <编号> [别名]` | 管理员 | 发布到 Bilibili（翻译 + 原图 + 话题） |
| `/重试 <编号> [@账号]` | 管理员 | 发布失败后重试 |
| `/刷新 [@账号]` | 管理员 | 立即轮询一次 |

- 编号为**账号内独立编号**；未指定账号的命令作用于默认账号
- 新推文入库即自动下载原图（最高画质）并在后台缓存，通知群时只发文本 + 推文截图
- `/媒体` **本地优先**：`cache/media/<推文ID>/` 里已经有文件就直接读本地（不联网、秒回）；
  缺失或之前下载失败过才去下载补齐。上传群文件时图片叫 `photo<n>.jpg|png`、视频叫 `video<n>.mp4`；
  超过 `MAX_GROUP_FILE_MB` 或下载失败的文件会单独列出跳过原因

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
- **数据**：数据库在 volume `app-data`（`/app/data/app.db`）；缓存在 `cache/`（与宿主机同路径挂载，NapCat 直接按绝对路径读取）
- **缓存目录**：
  - `cache/screenshots/<推文ID>.png`：推文截图，**永久保留**（数据库会引用，请勿手动删除）
  - `cache/media/<推文ID>/`：推文原图与视频，`photo<n>.<ext>` / `video<n>.<ext>`；新推文入库即自动下载，
    发布与 `/媒体` **本地优先**（已下载就直接读文件，缺失才下载补齐），不会重复下载
  - 媒体按 `MEDIA_CACHE_TTL_DAYS`（默认 7 天）由后台每 6 小时清理一次；如需彻底清空可整个删除 `cache/media/`（下次自动重新下载）
  - 旧版本遗留的 `cache/twitter-photos/`、`cache/video-thumbnails/`、`cache/exports/` 目录已废弃，可直接删除
- **发布失败**：`/发布` 返回 `BILIBILI_AUTH` → Cookie 失效 → 重新复制 `BILI_COOKIE_STRING`（连同
  `BILI_REFRESH_TOKEN`）→ `docker compose up -d app` → `/重试`
- **Bilibili 必须直连**（勿为其配置代理，会触发 CSRF/风控）；Twitter 媒体如需代理配 `HTTPS_PROXY`

---

## 参考与致谢

本项目在实现过程中参考或集成了以下第三方项目，感谢其作者与社区：

| 项目 | 用途 | 许可协议 |
| --- | --- | --- |
| [TweetToaster](https://github.com/cn-matsuri/TweetToaster)（夏色祭工坊烤推机） | Twitter/X 推文数据获取与推文截图，以其官方 Docker 镜像独立部署 | GPL-3.0 |
| [NoneBot2](https://github.com/nonebot/nonebot2) | QQ 机器人框架（本仓库 `nonebot-plugin/` 的运行环境） | MIT |
| [nonebot-adapter-onebot](https://github.com/nonebot/adapter-onebot) | NoneBot2 的 OneBot v11 适配器 | MIT |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | Linux QQ 无头运行与 OneBot v11 协议端，以 Docker 镜像方式使用 | Limited Redistribution License（非标准开源协议，详见其仓库 LICENSE） |
| [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) | 哔哩哔哩接口文档参考（动态发布、wbi 签名、Cookie 刷新等实现依据） | CC-BY-NC 4.0 |

说明：

- 以上项目均以**独立进程 / 容器**方式集成，或仅作**接口文档参考**；本仓库不包含、不修改、不再分发其源代码
- TweetToaster 采用 GPL-3.0：本项目仅通过 HTTP 调用其独立部署的服务，未修改或再分发其代码
- 各项目名称与版权归其作者所有，协议文本以各自仓库为准

---

## 目录

```text
src/              主程序（TypeScript）
  config/ db/ domain/ repositories/ services/
  tweettoaster/ media/ api/ bilibili/
scripts/          辅助脚本（bili-login.mjs：B 站扫码登录）
nonebot-plugin/   NoneBot2 插件（QQ 命令与通知）
docker-compose.yml 全栈编排（QQ 侧在 profile "full" 下）
start.sh         一键启动/状态/日志/停止
.env.example     环境变量模板
```

---

## 许可

本项目采用 **GNU Affero General Public License v3.0（AGPL-3.0）**，全文见 [`LICENSE`](LICENSE)。

Copyright (C) 2026 LinQi2333

这意味着：

- 你可以自由使用、修改、分发本项目
- 分发或提供服务时须**保留版权声明与许可文本**，并**公开相应源代码**
- **AGPL 第 13 条**：如果你修改后的版本通过网络对外提供服务，必须向使用者提供完整源代码
- 第三方项目（TweetToaster、NoneBot2、NapCatQQ、bilibili-API-collect 等）仍遵循各自协议，见上文「参考与致谢」

