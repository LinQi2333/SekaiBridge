"""主程序 HTTP API 调用封装（含消息去重，规格 §43）。"""
import httpx
from nonebot import get_driver
from nonebot.adapters.onebot.v11 import GroupMessageEvent
from pydantic import BaseModel


class TqbConfig(BaseModel):
    """插件配置（读取 .env 的 TQB_* 变量）。"""

    tqb_api_base: str = "http://127.0.0.1:18080"
    tqb_api_token: str = ""
    tqb_notify_group: str = ""


config: TqbConfig

def _load_config() -> TqbConfig:
    raw = get_driver().config.dict()
    # NoneBot2 会把纯数字环境变量解析成 int，这里统一转字符串
    for key in ("tqb_api_base", "tqb_api_token", "tqb_notify_group"):
        if key in raw and raw[key] is not None:
            raw[key] = str(raw[key])
    return TqbConfig(**raw)


config = _load_config()

_client: httpx.AsyncClient | None = None


async def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # trust_env=False：忽略环境变量代理（本机主程序 API 无需走代理）
        _client = httpx.AsyncClient(base_url=config.tqb_api_base, timeout=30, trust_env=False)
    return _client


def auth_headers(event: GroupMessageEvent | None = None) -> dict:
    headers = {"X-API-Token": config.tqb_api_token}
    if event is not None:
        headers["X-QQ-User"] = str(event.user_id)
        headers["X-QQ-Group"] = str(getattr(event, "group_id", ""))
        # 群角色（owner/admin/member）：主程序据此把群主/群管理视为管理员
        role = getattr(getattr(event, "sender", None), "role", None)
        if role in ("owner", "admin", "member"):
            headers["X-QQ-Role"] = role
    return headers


async def call_api(
    path: str,
    method: str = "GET",
    body: dict | None = None,
    event: GroupMessageEvent | None = None,
) -> dict:
    """调用主程序 API，返回 JSON（{ok, data} 或 {ok:false, error}）。

    注意：必须按 method 分派真实 HTTP 方法（PATCH/DELETE 不能走 POST），
    否则路由不匹配会 404。
    """
    from nonebot import logger

    client = await get_client()
    headers = auth_headers(event)
    payload = body or {}
    try:
        if method == "GET":
            resp = await client.get(path, headers=headers)
        elif method == "DELETE":
            resp = await client.delete(path, headers=headers)
        elif method == "PATCH":
            resp = await client.patch(path, headers=headers, json=payload)
        else:
            resp = await client.post(path, headers=headers, json=payload)
        logger.info(f"[tqb] {method} {path} -> HTTP {resp.status_code}")
        data = resp.json()
        logger.info(f"[tqb] 响应: {str(data)[:200]}")
        return data
    except Exception as exc:
        logger.error(f"[tqb] 调用异常 {method} {path}: {exc!r}")
        raise


async def dedupe_message(event: GroupMessageEvent) -> bool:
    """QQ 消息去重：重复消息返回 True，调用方应直接忽略。"""
    from nonebot import logger

    data = await call_api(
        "/api/messages/dedupe", "POST", {"message_id": str(event.message_id)}, event
    )
    duplicate = bool(data.get("data", {}).get("duplicate"))
    logger.info(f"[tqb] dedupe message_id={event.message_id} -> {duplicate}")
    return duplicate


def error_text(data: dict) -> str:
    return f"操作失败：{data.get('error', {}).get('message', '未知错误')}"
