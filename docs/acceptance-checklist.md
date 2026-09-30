# 验收清单

## 配置

- `GET /api/health` 返回 AI、飞书和安全配置均为 `true`。
- 健康接口和浏览器响应不包含任何密钥值。
- Vercel 已配置计划、设置、运营设备三个飞书子表 ID。
- 未登录时不能读取运行台或调用管理、手动生成、计划和提示词接口。
- 管理员登录 Cookie 为 HttpOnly、SameSite=Strict，过期或篡改后失效。

## 提示词与计划

- 提示词读取、进入编辑、取消和保存均正常。
- 刷新页面后，保存的提示词仍来自飞书。
- 可以创建、修改、停用和删除定时计划。
- 上海时区下的下次执行时间正确，星期和跨天计算无偏移。
- 相同计划和相同执行时刻重复触发时不产生重复任务。

## 工作流

- 文案包含标题、正文和话题标签，正文不超过 1000 字。
- 四级文案不混入六级内容，六级文案不混入四级内容。
- 4 张图片均为 1024x1536，格式为 PNG、JPEG 或 WebP，单张小于 20 MB。
- AI 图片最多有 2 个任务处于生成或轮询状态。
- 飞书素材上传和记录更新按顺序执行。
- 文案和每张图片完成后立即写回同一条飞书任务记录。
- 任务失败后按退避时间重试，超过次数后显示“需处理”。
- 手动重试不会重复生成已经成功的阶段。
- 过期任务锁能被新的在线心跳恢复。

## 飞书结果

- 正文下方空一行后直接出现横向话题标签。
- 4 张图片按顺序保存在同一个“图片”附件字段。
- “任务ID”相同的重复请求不会新增记录。
- 运行台能预览飞书附件并显示任务进度、错误和计划。
- 历史记录未被初始化脚本修改或删除。

## 运营电脑和社媒草稿

- 一次性连接码 20 分钟过期且只能使用一次。
- 运营电脑只保存设备凭证，不包含飞书、AI、Supabase 或管理员密钥。
- 设备凭证在 Windows 当前用户下使用 DPAPI 加密。
- 只有启用且被指定为执行设备的电脑可以领取草稿任务。
- 同一条飞书内容同时只锁定给一台设备；过期锁可恢复。
- 小红书和抖音分别记录 `等待建立 / 正在建立 / 草稿完成 / 需要处理`。
- 一个平台成功、另一个失败时，只重试失败平台。
- 图片上传、标题和正文填写、保存草稿均成功；最终发布按钮从不自动点击。
- 关闭运营电脑只停止社媒草稿建立，不影响 Vercel 生成和飞书保存。

## 全新 Windows 电脑

- 安装包自带 Node、Python 和 Chrome 控制组件，不要求手动安装 Node/Python/Git。
- 双击安装后自动打开向导，并创建当前用户的开机启动项。
- 向导能完成连接码配对、扩展目录提示、扩展配对、平台打开和测试任务。
- 卸载会移除启动项、本机设备凭证、图片缓存和 Chrome 控制桥运行数据。
- Chrome 扩展首次加载和最终移除有清晰的人工步骤。

## 在线执行

- 故障恢复时先单独执行 `supabase/emergency-stop.sql`，确认所有 `dailyforge-*` Cron 均为 `active = false`。
- CPU、Memory、IOwait、Database Errors 和 API Gateway Errors 恢复前，不执行 `supabase/heartbeat.sql` 或任何业务任务。
- 恢复后 Supabase 中只有一条启用的 `dailyforge-online-heartbeat`，没有 `dailyforge-run-worker`、`dailyforge-dispatch-schedules` 或清理任务。
- `dailyforge-online-heartbeat` 每分钟向 `/api/cron/tick` 发送一次 `POST`，HTTP 超时为 45 秒，不超过调度周期。
- 请求包含 `Authorization: Bearer <CRON_SECRET>`。
- Supabase Vault 中存在 `dailyforge_base_url` 和 `dailyforge_cron_secret`；验收时只检查名称，不输出值。
- Supabase 不保存文案、图片、任务或提示词，全部业务结果仍保存在飞书。
- 首次恢复只运行一条任务、一个 Worker，并确认 Supabase 指标没有再次升高。
- 用户电脑关闭后，Vercel 日志仍出现心跳请求，飞书任务继续推进。

## 本地检查

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```
