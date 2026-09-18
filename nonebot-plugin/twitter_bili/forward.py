"""合并转发（聊天记录卡片）：把推文原文单独推送到群。

通知推送与 !查看 都用这里，保证两处形态一致；发送失败只记日志，不影响主流程。
"""
import logging

from nonebot.adapters.onebot.v11 import Bot

logger = logging.getLogger("twitter_bili.forward")


def build_node(*, text: str, uin: str, author: str | None = None, seq: int | None = None,
               tweet_url: str | None = None) -> dict:
    """构造一个合并转发节点：标题为「@账号 #编号」，正文为原文（附原推链接）。"""
    body = text.strip()
    if tweet_url:
        body = f"{body}\n\n{tweet_url}"
    title = f"@{author} #{seq}" if author else "推文原文"
    return {
        "type": "node",
        "data": {
            "name": title,
            "uin": uin,
            "content": [{"type": "text", "data": {"text": body}}],
        },
    }


async def send_original_texts(
    bot: Bot,
    group_id: int,
    items: list[dict],
    source: str = "",
) -> bool:
    """把若干条推文原文以合并转发形式发到群；返回是否发送成功。

    items 每项形如 {"text": 原文, "author": 账号, "seq": 编号, "url": 原推链接}。
    原文为空的项会被跳过；全部为空则不发。
    """
    nodes = [
        build_node(
            text=str(item.get("text") or ""),
            uin=str(bot.self_id),
            author=item.get("author"),
            seq=item.get("seq"),
            tweet_url=item.get("url"),
        )
        for item in items
        if str(item.get("text") or "").strip()
    ]
    if not nodes:
        return False
    try:
        await bot.call_api("send_group_forward_msg", group_id=group_id, messages=nodes)
        return True
    except Exception:
        logger.exception("原文合并转发失败 %s", source or f"group={group_id}")
        return False
