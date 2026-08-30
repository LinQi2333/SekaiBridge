# NoneBot2 插件（实战验证版）

本目录是**在本机真实部署中验证可用**的 NoneBot2 插件（QQ → 主程序 HTTP API）。

## 目录

```text
nonebot-plugin/
├── bot.py                    # NoneBot2 入口（连接 NapCat OneBot WS）
└── twitter_bili/
    ├── __init__.py
    ├── api.py                # 主程序 HTTP API 调用封装（含消息去重 §43）
    ├── commands.py           # /监听 /列表 /查看 /翻译 /话题 /发布 /重试
    └── notification.py       # 新推文通知轮询（§42，拉取 + 发图 + ack）
```

## 安装与运行

```bash
# 1. 创建虚拟环境并安装依赖
python -m venv .venv
.venv/Scripts/pip install "nonebot2[fastapi]" nonebot-adapter-onebot httpx

# 2. 配置（复制为 .env 并修改）
cp .env.example .env

# 3. 运行
.venv/Scripts/python bot.py
```

## .env 配置

```env
DRIVER=~fastapi+~websockets+~httpx
HOST=127.0.0.1
PORT=8081
ONEBOT_WS_URLS=["ws://127.0.0.1:3001"]   # NapCat 的 OneBot WS 地址

# 主程序 API（与主程序 .env 一致）
TQB_API_BASE=http://127.0.0.1:18080
TQB_API_TOKEN=你的API_TOKEN
TQB_NOTIFY_GROUP=目标QQ群号
```

## 实战踩坑记录（重要）

1. **`args: Message = ...` 不生效**：NoneBot2 2.5 中命令参数必须用
   `args: Message = CommandArg()`（`from nonebot.params import CommandArg`），
   否则 handler 会被静默跳过（matcher 显示 complete 但不执行）。
2. **httpx 与系统代理**：本机配置了 Clash 环境变量代理时，httpx 会尝试走 SOCKS
   报 `socksio not installed`。本地 API 调用必须 `httpx.AsyncClient(..., trust_env=False)`。
3. **截图/图片路径**：主程序存的 `screenshotPath` 是绝对路径（NapCat 会从它自己
   的工作目录解析相对路径导致 ENOENT）。插件用 `file:///` + 绝对路径发送。
4. **NapCat 与 QQ 版本**：QQ 9.9.19 较旧，`NapCat.Shell.zip`（Shell 版）注入失败
   （无窗口、无 WebUI）；需用 `NapCat.Framework.zip`（LiteLoader 注入，支持 QQ ≥ 9.9.15）。

## 通知图片发送

通知轮询（notification.py）会自动发送截图与视频封面；
`/查看` 命令在有截图时附带推文截图（commands.py handle_show）。
