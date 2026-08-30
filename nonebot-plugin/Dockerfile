# NoneBot2 插件容器（QQ 命令 + 通知轮询）
FROM python:3.11-slim
WORKDIR /app

RUN pip install --no-cache-dir "nonebot2[fastapi]" nonebot-adapter-onebot httpx

COPY . .

# 配置通过环境变量注入（docker-compose 或运行时 -e）
CMD ["python", "bot.py"]
