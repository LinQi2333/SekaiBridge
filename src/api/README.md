# HTTP API（预留）

MVP 暂不启用 HTTP API（Phase 1-9 通过 QQ 与内部 Services 完成业务）。

未来网页端从 `src/api/` 接入同一套 Application Services：

```text
GET  /api/tweets
GET  /api/tweets/:id
POST /api/tweets/:id/translation
POST /api/tweets/:id/topic
POST /api/tweets/:id/publish
POST /api/tweets/:id/retry
```

核心约束：HTTP 层只做参数解析与结果格式化，
业务必须调用 `src/services/` 中的同一套服务（见 `src/services/index.ts`）。
