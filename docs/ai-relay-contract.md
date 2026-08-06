# AI 中转站接入契约

配置真实 API 时，需要提供以下信息。密钥应写入 `.env.local` 或 Vercel 环境变量，不要提交到 Git。

## 必需信息

```env
AI_RELAY_BASE_URL=
AI_RELAY_API_KEY=
AI_TEXT_MODEL=
AI_IMAGE_MODEL=
AI_TEXT_PATH=/v1/chat/completions
AI_IMAGE_PATH=/v1/images/generations
AI_TIMEOUT_MS=120000
AI_IMAGE_WIDTH=1024
AI_IMAGE_HEIGHT=1536
```

还需要各提供一份已脱敏的文案和图片真实响应示例。兼容接口之间经常在图片字段、异步任务字段和错误体上存在差异，仅有接口地址不足以验证适配。

## 文案接口

请求格式：

```json
{
  "model": "your-text-model",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.8,
  "response_format": { "type": "json_object" }
}
```

期望从 `choices[0].message.content` 读取 JSON 字符串。中转站必须说明是否支持 `response_format`；若不支持，只需在 Gateway 中删除该字段，不影响业务层。

## 图片接口

同步 Base64：

```json
{ "data": [{ "b64_json": "..." }] }
```

同步 URL：

```json
{ "data": [{ "url": "https://..." }] }
```

异步任务：

```json
{ "task_id": "img_123", "status": "queued" }
```

异步接口还需配置轮询路径，其中 `{taskId}` 会被替换：

```env
AI_IMAGE_POLL_PATH=/v1/images/tasks/{taskId}
```

轮询成功时返回 Base64 或 URL；未完成时继续返回 `task_id`。失败响应必须提供 HTTP 状态码或明确的 `status = failed`。

## 错误与限制

需要确认：

- 401/403、429、5xx 的真实响应体。
- 文案和图片请求的超时上限。
- 是否接受 `1024x1536` 尺寸。
- 图片最大文件大小和格式。
- 异步图片任务的建议轮询间隔及过期时间。
- 请求 ID、token usage、计费信息位于哪些字段。

目前 Gateway 记录请求 ID、输入/输出 token 和耗时；成本字段预留在数据库，得到中转站计价规则后再计算。
