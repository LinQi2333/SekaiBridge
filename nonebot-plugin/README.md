# NoneBot2 插件（twitter_bili）

QQ 群命令与通知插件：经 HTTP API 驱动主程序（SekaiBridge app）。

```text
nonebot-plugin/
├── bot.py                  # NoneBot2 入口（连接 NapCat OneBot WS）
└── twitter_bili/
    ├── __init__.py         # 导入子模块（按目录加载必需）
    ├── api.py              # 主程序 HTTP API 调用封装 + file:// URI 工具
    ├── commands.py         # QQ 命令：监听/列表/查看/翻译/话题/发布/重试/刷新
    └── notification.py     # 新推文通知轮询（拉取 → 发图 → ack）
```

## 安装运行（裸机部署）

```bash
# 1. 安装依赖（Python 3.10+）
python -m venv .venv
.venv/bin/pip install "nonebot2[fastapi]" nonebot-adapter-onebot httpx

# 2. 配置：复制 .env.example 为 .env，填入 NapCat 与主程序信息
# 3. 把 twitter_bili/ 放入 NoneBot2 的插件目录（如 rin/plugins/）
cp -r twitter_bili /你的NoneBot2/plugins/

# 4. 运行
.venv/bin/python bot.py
```

## .env 要点

```env
DRIVER=~fastapi+~websockets+~httpx
ONEBOT_WS_URLS=["ws://127.0.0.1:3001"]   # NapCat 的 OneBot WS 地址（WS 服务端模式反向亦可）

# 主程序 API（与主程序 .env 一致）
TQB_API_BASE=http://127.0.0.1:18080
TQB_API_TOKEN=你的API_TOKEN
TQB_NOTIFY_GROUP=通知发送的QQ群号
```

插件目录也可以直接由 Docker 全栈编排使用（`docker compose --profile full up -d`，见仓库根 README）。
