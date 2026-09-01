"""新推文通知轮询：拉取主程序 /api/notifications 并发送到 QQ 群（规格 §42）。"""
import asyncio
import logging

from nonebot import get_driver
from nonebot.adapters.onebot.v11 import Bot, MessageSegment

from .api import config, file_uri

logger = logging.getLogger("twitter_bili.notification")

driver = get_driver()
_task: asyncio.Task | None = None

POLL_INTERVAL = 2.0  # 拉取间隔（秒）


async def _send_notification(bot: Bot, notification: dict) -> None:
    """发送一条通知：文本 + 截图 + 视频封面。"""
    segments: list = [MessageSegment.text(notification["text"])]
    if notification.get("screenshotPath"):
        segments.append(MessageSegment.image(file_uri(notification["screenshotPath"])))
    for thumb in notification.get("videoThumbnails") or []:
        segments.append(MessageSegment.image(file_uri(thumb)))
    # 支持逗号分隔多个群：取第一个（TQB_NOTIFY_GROUP 可能与 QQ_GROUP_IDS 同源）
    group_id = int(config.tqb_notify_group.split(",")[0].strip())
    await bot.send_group_msg(group_id=group_id, message=segments)


async def _poll_loop(bot: Bot) -> None:
    import httpx

    async with httpx.AsyncClient(
        base_url=config.tqb_api_base, timeout=10, trust_env=False
    ) as client:
        while True:
            try:
                resp = await client.get(
                    "/api/notifications?limit=10",
                    headers={"X-API-Token": config.tqb_api_token},
                )
                data = resp.json()
                if not data.get("ok"):
                    logger.warning("通知拉取失败: %s", data.get("error"))
                    await asyncio.sleep(POLL_INTERVAL)
                    continue
                for notification in data["data"]["notifications"]:
                    try:
                        await _send_notification(bot, notification)
                        await client.post(
                            f"/api/notifications/{notification['id']}/ack",
                            headers={"X-API-Token": config.tqb_api_token},
                        )
                    except Exception:
                        logger.exception("通知发送失败 id=%s", notification["id"])
            except Exception:
                logger.exception("通知轮询异常")
            await asyncio.sleep(POLL_INTERVAL)


@driver.on_bot_connect
async def start_polling(bot: Bot) -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_poll_loop(bot))
        logger.info("通知轮询已启动")
