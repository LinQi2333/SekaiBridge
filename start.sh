#!/usr/bin/env bash
#
# Twitter→QQ→Bilibili 一键管理脚本（Linux / Docker）
#
# 用法:
#   ./start.sh            启动全部服务并展示状态（等价 start）
#   ./start.sh status     查看 4 个服务状态 + 健康检查 + NapCat 登录提示
#   ./start.sh logs [svc] 跟随日志（svc: app/tweettoaster/napcat/nonebot2）
#   ./start.sh stop       停止（保留数据）
#   ./start.sh restart    重启
#   ./start.sh down       停止并删除容器（数据卷保留）
#
set -euo pipefail
cd "$(dirname "$0")"

CMD="${1:-start}"

compose_ps() {
  docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
}

print_status() {
  echo "===== 服务状态（4 个容器） ====="
  compose_ps
  echo
  echo "===== 健康检查 ====="
  if curl -sf http://127.0.0.1:18080/api/health >/dev/null 2>&1; then
    echo "✔ 主程序 /api/health: $(curl -s http://127.0.0.1:18080/api/health)"
  else
    echo "✘ 主程序 /api/health 未就绪（可能仍在启动，稍后重试 ./start.sh status）"
  fi
  echo
  echo "===== NapCat / QQ 登录提示 ====="
  if docker compose ps --services 2>/dev/null | grep -qx napcat; then
    token="$(docker compose logs napcat 2>/dev/null | grep -ioE 'token[=: ]+[a-zA-Z0-9]+' | tail -1 | sed -E 's/.*[=: ]//')"
    echo "  机器人未登录时：浏览器打开 http://<服务器IP>:6099/webui 扫码登录"
    echo "  WebUI token: ${token:-（见 docker compose logs napcat）}"
  fi
}

case "$CMD" in
  start|up)
    PROFILE_FLAG=""
    if [ "${2:-}" = "full" ]; then PROFILE_FLAG="--profile full"; fi
    echo "==> 构建并启动服务...（${2:-默认: app+tweettoaster；full=全栈含 QQ 侧}）"
    docker compose $PROFILE_FLAG up -d --build
    echo
    # 等待主程序就绪（最多 60s）
    for i in $(seq 1 30); do
      if curl -sf http://127.0.0.1:18080/api/health >/dev/null 2>&1; then
        break
      fi
      sleep 2
    done
    print_status
    ;;
  status|ps)
    print_status
    ;;
  logs)
    shift || true
    docker compose logs -f --tail=100 "$@"
    ;;
  stop)
    docker compose stop
    ;;
  restart)
    docker compose restart
    ;;
  down)
    docker compose down
    ;;
  *)
    echo "用法: ./start.sh [start|status|logs [服务名]|stop|restart|down]"
    echo "服务名: app / tweettoaster / napcat / nonebot2"
    exit 1
    ;;
esac
