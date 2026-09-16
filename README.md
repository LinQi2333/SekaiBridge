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
vim .env        # 必填：QQ_GROUP_IDS / QQ_ADMIN_IDS / API_TOKEN
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
| `TWITTER_POLL_INTERVAL` | 监听轮询间隔（秒，默认 60） |
| `MEDIA_CACHE_TTL_DAYS` | 媒体缓存保留天数（默认 7；截图不受影响） |
| `MEDIA_EXPORT_MAX_MB` | 单个媒体文件下载上限（MB，默认 300） |
| `MAX_GROUP_FILE_MB` | QQ 群文件上限（MB，默认 100；超过则不上传并提示） |
| `HTTPS_PROXY` / `HTTP_PROXY` | 可选代理：访问 Twitter 图床被墙时配置 |

其余变量（端口、轮询等）可留默认，详见 `.env.example`。

> **Bilibili 凭据不在 `.env` 配置**：唯一来源是数据卷里的 `/app/data/bili-cookies.json`，
> 由扫码登录工具写入、由自动续期回写，路径固定不可改（见下）。

### Bilibili 登录（扫码，唯一方式）

凭据只存一个地方：数据卷里的 **`/app/data/bili-cookies.json`**（路径固定，不可配置）。
由扫码登录工具写入，之后由 `bili_ticket` / `SESSDATA` 自动续期回写。**不再支持手工填 Cookie 环境变量。**

```bash
cd /opt/sekai-bridge
git pull
docker compose stop app                                   # 先停 app，避免它把旧凭据写回文件
docker compose --profile tools run --rm --build --service-ports bili-login
#   → 浏览器打开 http://<服务器IP>:18081/ ，用手机 B 站 App 扫码并在手机上确认
docker compose up -d app
docker compose logs -f app | grep -i bilibili
```

- 二维码三种给法：**网页**（NapCat 式，失效会自动刷新）、**终端里直接打印**（网页打不开时用）、
  以及 PNG `cache/bili-login-qr.png`；网页打不开通常是云服务器安全组没放行 18081（临时放行即可，
  容器退出后端口自动释放）
- 扫码成功后终端会显示账号昵称，并把凭据**直接写进 app 的数据卷**，所以不需要改任何配置
- 不想要网页时（只打印终端二维码与 PNG）：把命令末尾换成完整脚本调用
  `docker compose --profile tools run --rm --service-ports bili-login node scripts/bili-login.mjs --no-serve`
- 没有 Docker 环境时可在本地电脑跑同一脚本：`npm install && npm run bili:login`
  （终端二维码 + 本地网页 `http://127.0.0.1:18081` + `bili-login-qr.png`）。本机运行会把凭据写到
  当前目录，再拷进容器即可：`docker compose cp bili-login-cookies.json app:/app/data/bili-cookies.json`

主程序每 6 小时做一次会话体检与自动续期（B 站 Web 端同款机制）：

- **`bili_ticket`**：始终自动续期（有效期 3 天），新值写回凭据文件
- **`SESSDATA`**：B 站提示临近过期时自动续期（`cookie/info` → CorrespondPath →
  `refresh_csrf` → `cookie/refresh` → `confirm/refresh`），新 Cookie 与**轮换后的刷新口令**
  一起写回凭据文件，因此只需扫码一次
- 续期成功日志：`[bilibili] SESSDATA 已自动续期，有效期至 ...`
- 续期失败（如刷新口令被作废 `code=86095`、被风控）会打印原因，并把已失效的刷新口令从文件里清掉；
  此时**重跑一次上面的扫码登录**即可（旧 SESSDATA 在真正过期前仍能正常发布）
- `checkSession` 发现凭据文件不存在/失效时，日志会直接给出这条扫码登录命令

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
- **发布失败**：`/发布` 返回 `BILIBILI_AUTH` → 登录失效 → 重新扫码登录（见「Bilibili 登录」）→
  `docker compose up -d app` → `/重试`
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

