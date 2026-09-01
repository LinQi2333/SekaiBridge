"""QQ 群命令插件：!监听 !列表 !查看 !翻译 !发布 !重试 !刷新。

多账号模型：
- 每个监听账号拥有独立的推文编号（seq），命令中的编号指账号内编号；
- 未指定账号的命令（列表/查看/翻译/发布/刷新）作用于默认账号；
- !监听 默认 @账号 可切换默认账号。
"""
from nonebot import on_command
from nonebot.adapters.onebot.v11 import Bot, GroupMessageEvent, Message, MessageSegment
from nonebot.params import CommandArg

from .api import call_api, dedupe_message, error_text

watch = on_command("监听", priority=1)
tweet_list = on_command("列表", priority=1)
show = on_command("查看", priority=1)
translate = on_command("翻译", priority=1)
publish = on_command("发布", priority=1)
retry = on_command("重试", priority=1)
refresh = on_command("刷新", priority=1)

PENDING_LABELS = {"pending": "待翻译", "translated": "已翻译", "published": "已发布", "failed": "失败", "all": "全部"}

# 兼容中英文状态词（!列表 已翻译 与 !列表 translated 等价）
STATUS_ALIASES = {
    "pending": "pending", "待翻译": "pending", "待处理": "pending",
    "translated": "translated", "已翻译": "translated",
    "published": "published", "已发布": "published",
    "failed": "failed", "失败": "failed", "发布失败": "failed",
    "all": "all", "全部": "all",
}


def summarize(text: str, max_chars: int = 30) -> str:
    """推文内容摘要：合并空白/换行后截取前 max_chars 个字符。"""
    flat = " ".join((text or "").split())
    if len(flat) <= max_chars:
        return flat
    return flat[:max_chars] + "…"


def pick_account(parts: list[str]) -> str | None:
    """从参数中提取 @账号（第一个以 @ 开头的 token）。"""
    for p in parts:
        if p.startswith("@"):
            return p.lstrip("@").strip()
    return None


async def precheck(event: GroupMessageEvent) -> bool:
    """消息去重：重复消息返回 True，直接忽略。"""
    return await dedupe_message(event)


async def resolve_tweet(
    event: GroupMessageEvent, seq: str, account: str | None = None
) -> tuple[dict | None, dict]:
    """按账号内编号解析推文（账号缺省用默认账号），返回 (tweet, data)。"""
    path = f"/api/tweets/resolve?seq={seq}"
    if account:
        path += f"&account={account}"
    data = await call_api(path, "GET", event=event)
    if not data.get("ok"):
        return None, data
    return data["data"]["tweet"], data


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
            await bot.send(event, "当前没有监听账户。\n\n用法：!监听 添加 @账号 | !监听 默认 @账号")
            return
        lines = ["当前监听账户（⭐=默认账号）："]
        for a in accounts:
            state = "开启" if a["enabled"] else "关闭"
            mark = "⭐ " if a["isDefault"] else "   "
            lines.append(f"{mark}@{a['screenName']}  {state}")
        lines.append("\n用法：!监听 添加 @账号 | !监听 默认 @账号 | !监听 开启/关闭/删除 @账号")
        await bot.send(event, "\n".join(lines))
        return
    action, _, name = msg.partition(" ")
    name = name.strip().lstrip("@")
    if action == "添加":
        if not name:
            await bot.send(event, "用法：!监听 添加 @账号")
            return
        data = await call_api("/api/watched-accounts", "POST", {"screen_name": name}, event)
        if data.get("ok"):
            await bot.send(event, f"已监听 @{name}（首个账号自动设为默认）")
        else:
            await bot.send(event, error_text(data))
        return
    if action == "默认":
        if not name:
            await bot.send(event, "用法：!监听 默认 @账号")
            return
        data = await call_api(f"/api/watched-accounts/{name}", "PATCH", {"default": True}, event)
        if data.get("ok"):
            await bot.send(event, f"已将 @{name} 设为默认账号")
        else:
            await bot.send(event, error_text(data))
        return
    if action in ("开启", "关闭"):
        if not name:
            await bot.send(event, f"用法：!监听 {action} @账号")
            return
        data = await call_api(
            f"/api/watched-accounts/{name}", "PATCH", {"enabled": action == "开启"}, event
        )
    elif action == "删除":
        if not name:
            await bot.send(event, "用法：!监听 删除 @账号")
            return
        data = await call_api(f"/api/watched-accounts/{name}", "DELETE", event=event)
        if data.get("ok"):
            removed = data["data"].get("removed")
            cleaned = data["data"].get("tweetsDeleted", 0)
            if removed:
                await bot.send(event, f"已删除 @{name}，并清空其 {cleaned} 条历史推文")
                return
        await bot.send(event, error_text(data))
        return
    else:
        await bot.send(event, "用法：!监听 | !监听 添加 @账号 | !监听 默认 @账号 | !监听 开启 @账号 | !监听 关闭 @账号 | !监听 删除 @账号")
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
    account = None
    for p in parts:
        if p.startswith("@"):
            account = p.lstrip("@")
        elif p in STATUS_ALIASES:
            status = STATUS_ALIASES[p]
        elif p.isdigit():
            page = int(p)
    query = f"/api/tweets?status={status}&page={page}&page_size=10"
    if account:
        query += f"&account={account}"
    data = await call_api(query, "GET", event=event)
    if not data.get("ok"):
        await bot.send(event, error_text(data))
        return
    result = data["data"]
    acct = result.get("account") or ""
    if not result["items"]:
        await bot.send(event, f"@{acct} 暂无{PENDING_LABELS[status]}任务")
        return
    lines = []
    for t in result["items"]:
        deleted = "原推已删除 / " if t["sourceStatus"] == "SOURCE_DELETED" else ""
        lines.append(
            f"#{t['seq']} @{t['authorScreenName']}   {deleted}{t['workflowStatus']}\n"
            f"{summarize(t.get('originalText'))}"
        )
    total_pages = max(1, (result["total"] + 9) // 10)
    lines.append(f"\n@{acct} · 第 {page}/{total_pages} 页 · 共 {result['total']} 条")
    await bot.send(event, "\n\n".join(lines))


@show.handle()
async def handle_show(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    parts = args.extract_plain_text().strip().replace("，", ",").split()
    seqs = [p for p in parts if p.isdigit()]
    account = pick_account(parts)
    if not seqs:
        await bot.send(event, "用法：!查看 <编号> [@账号]\n例：!查看 3 | !查看 3,5 @pj_sekai")
        return
    for seq in seqs:
        tweet, data = await resolve_tweet(event, seq, account)
        if tweet is None:
            await bot.send(event, error_text(data))
            continue
        deleted = "⚠️ 原推已删除" if tweet["sourceStatus"] == "SOURCE_DELETED" else "正常"
        text = (
            f"@{tweet['authorScreenName']} #{tweet['seq']}\n"
            f"来源状态：{deleted}\n工作状态：{tweet['workflowStatus']}\n"
            f"原推：\n{tweet['tweetUrl']}"
        )
        if tweet.get("screenshotPath"):
            segments = [
                MessageSegment.text(text + "\n\n[推文截图]"),
                MessageSegment.image(f"file:///{tweet['screenshotPath'].replace(chr(92), '/')}"),
            ]
            await bot.send(event, segments)
        else:
            text += "\n\n（该推文暂无截图：历史/待处理推文，新推文会自动生成截图）"
            await bot.send(event, text)


@translate.handle()
async def handle_translate(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    text = args.extract_plain_text().strip()
    first_line, _, content = text.partition("\n")
    tokens = first_line.split()
    if not tokens or not tokens[0].isdigit() or not content.strip():
        await bot.send(event, "用法：!翻译 <编号> [@账号]\n翻译内容...（第二行开始是翻译正文）")
        return
    seq = tokens[0]
    account = pick_account(tokens[1:])
    tweet, data = await resolve_tweet(event, seq, account)
    if tweet is None:
        await bot.send(event, error_text(data))
        return
    data = await call_api(
        f"/api/tweets/{tweet['id']}/translation",
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
        f"@{tweet['authorScreenName']} #{seq} 翻译已保存。\n\n当前版本：v{tr['version']}\n"
        f"状态：已翻译，等待发布。\n\n可继续：\n!发布 {seq} [话题别名]",
    )


@publish.handle()
async def handle_publish(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    parts = args.extract_plain_text().strip().split()
    if not parts or not parts[0].isdigit():
        await bot.send(event, "用法：!发布 <编号> [话题别名] [@账号]")
        return
    seq = parts[0]
    account = pick_account(parts[1:])
    alias = next((p for p in parts[1:] if not p.startswith("@") and p != seq), None)
    tweet, data = await resolve_tweet(event, seq, account)
    if tweet is None:
        await bot.send(event, error_text(data))
        return
    body = {"topic_alias": alias} if alias else {}
    data = await call_api(f"/api/tweets/{tweet['id']}/publish", "POST", body, event)
    if data.get("ok"):
        record = data["data"]["result"]["record"]
        await bot.send(event, f"@{tweet['authorScreenName']} #{seq} 已发布。\n\nBilibili Dynamic ID:\n{record['biliDynamicId']}")
    else:
        await bot.send(event, error_text(data))


@retry.handle()
async def handle_retry(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    if await precheck(event):
        return
    parts = args.extract_plain_text().strip().split()
    if not parts or not parts[0].isdigit():
        await bot.send(event, "用法：!重试 <编号> [@账号]")
        return
    seq = parts[0]
    account = pick_account(parts[1:])
    tweet, data = await resolve_tweet(event, seq, account)
    if tweet is None:
        await bot.send(event, error_text(data))
        return
    data = await call_api(f"/api/tweets/{tweet['id']}/retry", "POST", event=event)
    if data.get("ok"):
        record = data["data"]["result"]["record"]
        await bot.send(event, f"@{tweet['authorScreenName']} #{seq} 已发布。\n\nBilibili Dynamic ID:\n{record['biliDynamicId']}")
    else:
        await bot.send(event, error_text(data))


@refresh.handle()
async def handle_refresh(bot: Bot, event: GroupMessageEvent, args: Message = CommandArg()):
    """立即刷新：!刷新 [@账号]；不指定账号时刷新全部启用账户。"""
    if await precheck(event):
        return
    parts = args.extract_plain_text().strip().split()
    account = pick_account(parts)
    body = {"account": account} if account else {}
    data = await call_api("/api/refresh", "POST", body, event)
    if not data.get("ok"):
        await bot.send(event, error_text(data))
        return
    results = data["data"]["results"]
    if not results:
        await bot.send(event, "没有启用的监听账户")
        return
    lines = []
    for r in results:
        if r["error"]:
            lines.append(f"@{r['screenName']} 刷新失败：{r['error']}")
        else:
            mode = "首次监听（历史已记录，本轮不通知）" if r["mode"] == "bootstrap" else "增量"
            lines.append(
                f"@{r['screenName']} 刷新完成：读取 {r['timelineCount']} 条，新增 {len(r['newTweets'])} 条（{mode}）"
            )
    await bot.send(event, "\n".join(lines))
