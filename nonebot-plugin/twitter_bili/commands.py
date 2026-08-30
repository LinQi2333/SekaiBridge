"""QQ 群命令插件：/监听 /列表 /查看 /翻译 /话题 /发布 /重试。"""
from nonebot import on_command
from nonebot.adapters.onebot.v11 import Bot, GroupMessageEvent, Message, MessageSegment
from nonebot.params import CommandArg

from .api import call_api, dedupe_message, error_text

watch = on_command("监听", priority=1)
tweet_list = on_command("列表", priority=1)
show = on_command("查看", priority=1)
translate = on_command("翻译", priority=1)
topic = on_command("话题", priority=1)
publish = on_command("发布", priority=1)
retry = on_command("重试", priority=1)

PENDING_LABELS = {"pending": "待翻译", "translated": "已翻译", "published": "已发布", "failed": "失败", "all": "全部"}


async def precheck(event: GroupMessageEvent) -> bool:
    """消息去重：重复消息返回 True，直接忽略。"""
    return await dedupe_message(event)


@watch.handle()
async def handle_watch(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    msg = args.extract_plain_text().strip().replace("@", "")
    if not msg:
        data = await call_api("/api/watched-accounts", "GET", event=event)
        if not data.get("ok"):
            await bot.send(event, error_text(data))
            return
        accounts = data["data"]["accounts"]
        if not accounts:
            await bot.send(event, "当前没有监听账户。\n\n用法：/监听 添加 @账号")
            return
        lines = ["当前监听账户："]
        for i, a in enumerate(accounts, 1):
            lines.append(f"{i}. @{a['screenName']}    {'开启' if a['enabled'] else '关闭'}")
        lines.append("\n用法：/监听 添加 @账号 | 开启 @账号 | 关闭 @账号 | 删除 @账号")
        await bot.send(event, "\n".join(lines))
        return
    action, _, name = msg.partition(" ")
    name = name.strip().lstrip("@")
    if action == "添加":
        if not name:
            await bot.send(event, "用法：/监听 添加 @账号")
            return
        data = await call_api("/api/watched-accounts", "POST", {"screen_name": name}, event)
    elif action in ("开启", "关闭"):
        if not name:
            await bot.send(event, f"用法：/监听 {action} @账号")
            return
        data = await call_api(
            f"/api/watched-accounts/{name}", "PATCH", {"enabled": action == "开启"}, event
        )
    elif action == "删除":
        if not name:
            await bot.send(event, "用法：/监听 删除 @账号")
            return
        data = await call_api(f"/api/watched-accounts/{name}", "DELETE", event=event)
    else:
        await bot.send(event, "用法：/监听 | /监听 添加 @账号 | /监听 开启 @账号 | /监听 关闭 @账号 | /监听 删除 @账号")
        return
    if data.get("ok"):
        await bot.send(event, "操作成功")
    else:
        await bot.send(event, error_text(data))


@tweet_list.handle()
async def handle_list(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    parts = args.extract_plain_text().strip().split()
    status = "pending"
    page = 1
    if parts:
        if parts[0] in PENDING_LABELS:
            status = parts[0]
            if len(parts) > 1 and parts[1].isdigit():
                page = int(parts[1])
        elif parts[0].isdigit():
            page = int(parts[0])
    data = await call_api(
        f"/api/tweets?status={status}&page={page}&page_size=10", "GET", event=event
    )
    if not data.get("ok"):
        await bot.send(event, error_text(data))
        return
    result = data["data"]
    if not result["items"]:
        await bot.send(event, f"暂无{PENDING_LABELS[status]}任务")
        return
    lines = []
    for t in result["items"]:
        deleted = "原推已删除 / " if t["sourceStatus"] == "SOURCE_DELETED" else ""
        lines.append(f"#{t['id']} @{t['authorScreenName']}   {deleted}{t['workflowStatus']}")
    total_pages = max(1, (result["total"] + 9) // 10)
    lines.append(f"\n第 {page}/{total_pages} 页 · 共 {result['total']} 条")
    await bot.send(event, "\n".join(lines))


@show.handle()
async def handle_show(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    ids = args.extract_plain_text().strip().replace("，", ",").replace(" ", ",")
    if not ids:
        await bot.send(event, "用法：/查看 <编号> 或 /查看 152,155")
        return
    data = await call_api(f"/api/tweets?ids={ids}", "GET", event=event)
    if not data.get("ok"):
        await bot.send(event, error_text(data))
        return
    result = data["data"]
    for t in result["tweets"]:
        deleted = "⚠️ 原推已删除" if t["sourceStatus"] == "SOURCE_DELETED" else "正常"
        text = (
            f"#{t['id']} @{t['authorScreenName']}\n"
            f"来源状态：{deleted}\n工作状态：{t['workflowStatus']}\n"
            f"原推：\n{t['tweetUrl']}"
        )
        if t.get("screenshotPath"):
            # 发送文本 + 推文截图（图片来自主程序本地缓存路径）
            segments = [
                MessageSegment.text(text + "\n\n[推文截图]"),
                MessageSegment.image(f"file:///{t['screenshotPath'].replace(chr(92), '/')}"),
            ]
            await bot.send(event, segments)
        else:
            text += "\n\n（该推文暂无截图：历史/待处理推文，新推文会自动生成截图）"
            await bot.send(event, text)
    if result["missing"]:
        await bot.send(event, "未找到：" + ",".join(f"#{i}" for i in result["missing"]))


@translate.handle()
async def handle_translate(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    text = args.extract_plain_text().strip()
    first_line, _, content = text.partition("\n")
    parts = first_line.split()
    if not parts or not parts[0].isdigit() or not content.strip():
        await bot.send(event, "用法：/翻译 <编号>\n翻译内容...（第二行开始是翻译正文）")
        return
    tweet_id = parts[0]
    data = await call_api(
        f"/api/tweets/{tweet_id}/translation",
        "POST",
        {"text": content, "qq_user_id": str(event.user_id)},
        event,
    )
    if not data.get("ok"):
        await bot.send(event, error_text(data))
        return
    tr = data["data"]["result"]["translation"]
    await bot.send(
        event,
        f"推文 #{tweet_id} 翻译已保存。\n\n当前版本：v{tr['version']}\n"
        f"状态：已翻译，等待发布。\n\n可继续：\n/话题 {tweet_id} hololive\n/发布 {tweet_id}",
    )


@topic.handle()
async def handle_topic(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    parts = args.extract_plain_text().strip().split()
    if len(parts) < 2 or not parts[0].isdigit():
        await bot.send(event, "用法：/话题 <编号> <别名|无>")
        return
    tweet_id, alias = parts[0], parts[1]
    body = {"alias": None if alias in ("无", "none") else alias}
    data = await call_api(f"/api/tweets/{tweet_id}/topic", "POST", body, event)
    if data.get("ok"):
        t = data["data"]["tweet"]
        await bot.send(event, f"#{tweet_id} 话题：{t['topicAlias'] or '（无）'}")
    else:
        await bot.send(event, error_text(data))


@publish.handle()
async def handle_publish(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    parts = args.extract_plain_text().strip().split()
    if not parts or not parts[0].isdigit():
        await bot.send(event, "用法：/发布 <编号> [话题别名]")
        return
    tweet_id = parts[0]
    body = {"topic_alias": parts[1]} if len(parts) > 1 else {}
    data = await call_api(f"/api/tweets/{tweet_id}/publish", "POST", body, event)
    if data.get("ok"):
        record = data["data"]["result"]["record"]
        await bot.send(event, f"#{tweet_id} 已发布。\n\nBilibili Dynamic ID:\n{record['biliDynamicId']}")
    else:
        await bot.send(event, error_text(data))


@retry.handle()
async def handle_retry(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    tweet_id = args.extract_plain_text().strip()
    if not tweet_id.isdigit():
        await bot.send(event, "用法：/重试 <编号>")
        return
    data = await call_api(f"/api/tweets/{tweet_id}/retry", "POST", event=event)
    if data.get("ok"):
        record = data["data"]["result"]["record"]
        await bot.send(event, f"#{tweet_id} 已发布。\n\nBilibili Dynamic ID:\n{record['biliDynamicId']}")
    else:
        await bot.send(event, error_text(data))
