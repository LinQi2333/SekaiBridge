"""新推文通知轮询：拉取主程序 /api/notifications 并发送到 QQ 群（规格 §42）。

发送策略（NapCat 的 sendMsg 偶尔会返回 retcode 1200 内部超时）：
1. 先检查截图文件是否存在/非空，缺失就只发文本（图片不可读是超时最常见诱因）；
2. 失败重试，重试时**去掉图片**再发一次（纯文本成功率更高）；
3. 仍失败则放弃并 ack，同时在群里提示一条纯文本，避免队列被一条坏消息堵住。
"""
import asyncio
import logging
import os

from nonebot import get_driver
from nonebot.adapters.onebot.v11 import Bot, MessageSegment

from .api import config, file_uri
from .forward import send_original_texts

logger = logging.getLogger("twitter_bili.notification")

driver = get_driver()
_task: asyncio.Task | None = None

POLL_INTERVAL = 2.0  # 拉取间隔（秒）
# 重试等待（秒）：首次立即发，之后各等 5s / 15s
RETRY_DELAYS = (0, 5, 15)


def _notify_group() -> int:
    """支持逗号分隔多个群：取第一个（TQB_NOTIFY_GROUP 可能与 QQ_GROUP_IDS 同源）。"""
    return int(config.tqb_notify_group.split(",")[0].strip())


def _usable_screenshot(path: str | None) -> str | None:
    """截图可用返回路径；缺失或 0 字节返回 None（图片不可读会让 NapCat 卡到超时）。"""
    if not path:
        return None
    try:
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path
    except OSError:
        return None
    return None


def _build_segments(notification: dict, with_image: bool) -> list:
    segments: list = [MessageSegment.text(notification["text"])]
    if not with_image:
        return segments
    shot = _usable_screenshot(notification.get("screenshotPath"))
    if shot is None:
        logger.warning(
            "截图缺失或为空，改为纯文本通知 id=%s path=%s",
            notification.get("id"),
            notification.get("screenshotPath"),
        )
        return segments
    segments.append(MessageSegment.image(file_uri(shot)))
    return segments


async def _send_once(bot: Bot, notification: dict, with_image: bool) -> None:
    group_id = _notify_group()
    await bot.send_group_msg(
        group_id=group_id, message=_build_segments(notification, with_image)
    )


async def _send_notification(bot: Bot, notification: dict) -> bool:
    """发送一条通知；返回 False 表示多次重试后仍失败（调用方应 ack 以免堵队列）。"""
    last_error: Exception | None = None
    for index, delay in enumerate(RETRY_DELAYS):
        if delay:
            await asyncio.sleep(delay)
        # 第一次带图；重试时改为纯文本（NapCat 的 1200 超时多与图片处理有关）
        with_image = index == 0
        try:
            await _send_once(bot, notification, with_image)
            if index > 0:
                logger.warning(
                    "通知 id=%s 第 %d 次重试成功（%s）",
                    notification.get("id"),
                    index + 1,
                    "含图片" if with_image else "纯文本",
                )
            break
        except Exception as exc:  # noqa: BLE001 - 单条通知失败不应中断轮询
            last_error = exc
            logger.warning(
                "通知发送失败（第 %d/%d 次，%s）id=%s: %s",
                index + 1,
                len(RETRY_DELAYS),
                "含图片" if with_image else "纯文本",
                notification.get("id"),
                exc,
            )
    else:
        logger.error("通知 id=%s 多次重试仍失败，放弃：%s", notification.get("id"), last_error)
        await _send_give_up_notice(bot, notification, last_error)
        return False

    await send_original_texts(
        bot,
        _notify_group(),
        [
            {
                "text": notification.get("originalText"),
                "author": notification.get("authorScreenName"),
                "seq": notification.get("seq"),
                "url": notification.get("tweetUrl"),
            }
        ],
        source=f"notification#{notification.get('id')}",
    )
    return True


async def _send_give_up_notice(bot: Bot, notification: dict, error: Exception | None) -> None:
    """放弃时给群里留一条纯文本，说明这条通知没发出去（尽力而为）。"""
    try:
        await bot.send_group_msg(
            group_id=_notify_group(),
            message=[
                MessageSegment.text(
                    f"⚠️ 通知 #{notification.get('seq')} 发送失败，已跳过（不影响后续通知）。"
                    f"\n原因：{error}"
                )
            ],
        )
    except Exception:  # noqa: BLE001 - 连放弃提示都失败就只记日志
        logger.exception("放弃提示发送失败 id=%s", notification.get("id"))


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
                    # 成功或彻底失败都 ack：否则一条坏通知会被每 2 秒重试一次，永远堵在前面
                    await _send_notification(bot, notification)
                    try:
                        await client.post(
                            f"/api/notifications/{notification['id']}/ack",
                            headers={"X-API-Token": config.tqb_api_token},
                        )
                    except Exception:
                        logger.exception("通知 ack 失败 id=%s", notification["id"])
            except Exception:
                logger.exception("通知轮询异常")
            await asyncio.sleep(POLL_INTERVAL)


@driver.on_bot_connect
async def start_polling(bot: Bot) -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_poll_loop(bot))
        logger.info("通知轮询已启动")
