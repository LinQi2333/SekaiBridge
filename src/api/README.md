# HTTP API（NoneBot2 / 未来 Web 接入）

Phase 6 起启用。NoneBot2（Python，连 NapCat）与未来 Web 通过这里调用同一套 Application Services。
本层只做鉴权、权限、参数解析、结果格式化；业务全部在 `src/services/`。

## 鉴权

- `X-API-Token`：与 `.env` 的 `API_TOKEN` 一致（未配置则不校验）。
- `X-QQ-User`：调用者 QQ 号（必填）。
- `X-QQ-Group`：消息所在群号（可选；配置了 `QQ_GROUP_IDS` 时校验群白名单）。

权限（规格 §41）：`/api/tweets*`、`/api/messages/dedupe` 成员可用；
监听管理与发布/重试仅管理员。

## 端点

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 无 | 健康检查（§57） |
| GET | `/api/watched-accounts` | admin | 监听账户列表（/监听） |
| POST | `/api/watched-accounts` | admin | `{screen_name}` 添加 |
| PATCH | `/api/watched-accounts/:name` | admin | `{enabled}` 开启/关闭 |
| DELETE | `/api/watched-accounts/:name` | admin | 删除 |
| GET | `/api/tweets?status=&page=&page_size=` | member | 任务列表（/列表） |
| GET | `/api/tweets?ids=152,155` | member | 多条查看（/查看） |
| GET | `/api/tweets/:id` | member | 单条查看，附 `format.view` 文本与 `screenshotPath` |
| POST | `/api/tweets/:id/translation` | member | `{text, qq_user_id}`（/翻译） |
| POST | `/api/tweets/:id/topic` | member | `{alias\|null}`（/话题） |
| POST | `/api/tweets/:id/publish` | admin | `{topic_alias?}`（/发布） |
| POST | `/api/tweets/:id/retry` | admin | 重试发布（/重试） |
| GET | `/api/notifications?limit=` | token | 拉取待发送的新推文通知（§42） |
| POST | `/api/notifications/:id/ack` | token | 标记通知已发送 |
| POST | `/api/messages/dedupe` | member | `{message_id}` QQ 消息去重（§43） |

## 错误

统一 `{ok, data}` / `{ok:false, error:{code,message}}`。
404/400/409/403/401/501（发布服务 Phase 8 前返回 501）。
