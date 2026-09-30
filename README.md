# DailyForge Lite

DailyForge Lite 是一条面向小红书和抖音图文的内容生产流水线：云端按计划生成文案和 4 张图片并保存到飞书，运营电脑再从飞书领取成品、建立两个平台草稿，最终发布始终由人工确认。

## 当前能力

- 四级内容优先面向准大一、大一新生，六级内容面向大学生进阶备考。
- 文案包含标题、正文和横向排列的话题标签，正文不超过 1000 字。
- 每篇生成 4 张 1024x1536 图片，统一保存在一个飞书附件字段。
- 提示词和定时计划可在运行台修改，保存后写入飞书。
- 同一批次使用确定性任务 ID，重复触发不会重复创建。
- 每条任务之间随机等待 1 至 9 秒，图片任务最多同时进行 2 个。
- 每个生成阶段可恢复、可重试；过期任务锁会自动回收。
- AI 图片验证后直接上传飞书，不保存数据库或对象存储副本。
- 管理运行台有独立访问口令；运营电脑只使用一次性连接码，不接触飞书、AI 或定时密钥。
- 一台运营电脑可被指定为草稿执行设备，自动填入小红书和抖音并保存草稿，不点击最终发布。

## 数据结构

一个飞书多维表格应用包含四张数据表：

- 内容表：文案、图片、审核结果和内部任务状态。
- `DailyForge 定时计划`：执行时间、星期、条数、四六级模式。
- `DailyForge 系统设置`：文案提示词和图片提示词。
- `DailyForge 运营设备`：设备连接码哈希、设备凭证哈希、启停状态和最近在线时间。

产品事实和基础选题目录保存在 [`src/lib/catalog.ts`](src/lib/catalog.ts)，避免把稳定配置拆成更多数据表。

## 本地启动

要求 Node.js 20.9 或更高版本。

```powershell
npm install
Copy-Item .env.example .env.local
npm run setup:feishu
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

## 环境配置

```env
# AI 中转站
AI_RELAY_BASE_URL=
AI_RELAY_API_KEY=
AI_TEXT_MODEL=
AI_IMAGE_MODEL=
AI_REVIEW_MODEL=
AI_TEXT_PATH=/v1/chat/completions
AI_IMAGE_PATH=/v1/images/generations
AI_IMAGE_POLL_PATH=/v1/images/tasks/{taskId}
AI_TIMEOUT_MS=280000
AI_IMAGE_WIDTH=1024
AI_IMAGE_HEIGHT=1536

# 飞书企业自建应用
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_BITABLE_APP_TOKEN=
FEISHU_TABLE_ID=
FEISHU_SCHEDULE_TABLE_ID=
FEISHU_SETTINGS_TABLE_ID=
FEISHU_DEVICE_TABLE_ID=

# 在线定时接口和管理运行台保护
CRON_SECRET=
WORKER_SECRET=
ADMIN_ACCESS_KEY=

DEFAULT_PLATFORM=xiaohongshu
DAILY_GENERATION_COUNT=1
APP_TIMEZONE=Asia/Shanghai
```

`npm run setup:feishu` 会在内容表补齐内部字段，并幂等创建计划表、设置表和运营设备表。脚本不会修改或删除历史内容。把脚本返回的三个子表 ID 写入环境变量后再部署。

## 运营电脑交付

运营电脑不需要安装 Node.js、Python、Git，也不需要任何 API 密钥。管理员先构建一个自带运行环境的安装包：

```powershell
npm run package:companion
```

安装包输出到 `artifacts/operator-package/DailyForge-Operator.zip`。运营人员只需：

1. 解压并双击 `Install-DailyForge.cmd`。
2. 在管理运行台“运营电脑”区域创建一次性连接码并输入向导。
3. 首次按向导加载 Chrome 扩展、完成配对，并登录小红书和抖音。
4. 日常只检查平台草稿，确认无误后手动发布。

本机助手在 Windows 用户登录后启动，不安装 Windows Service。详细步骤见 [`docs/operator-onboarding.md`](docs/operator-onboarding.md)，管理员部署见 [`docs/admin-deployment.md`](docs/admin-deployment.md)。

## 在线自动执行

部署到 Vercel 后，由现有 Supabase 项目的 `pg_cron` 每分钟发送一次心跳：

```text
POST https://YOUR_DOMAIN/api/cron/tick
Authorization: Bearer YOUR_CRON_SECRET
```

一次心跳会先检查到期计划，再推进一个待处理阶段。接口与飞书任务 ID 都具备幂等保护，重复请求不会重复创建同一批内容。

Supabase 只负责这条在线心跳，不保存文案、图片、任务或提示词。全部业务数据仍直接保存在飞书，因此不需要 cron-job.org 或其他外部定时软件。心跳的 HTTP 超时为 45 秒，低于 60 秒调度周期，避免 Supabase 中堆积长时间请求。可重复执行的配置见 [`supabase/heartbeat.sql`](supabase/heartbeat.sql)，它只引用 Vault 中的 `dailyforge_base_url` 和 `dailyforge_cron_secret`，不会把密钥写入仓库。

### Supabase 故障恢复顺序

发生资源耗尽、`503 / Hot standby` 或 API Gateway 大量错误时，不要执行心跳脚本或业务任务：

1. 单独在 Supabase SQL Editor 执行 [`supabase/emergency-stop.sql`](supabase/emergency-stop.sql)，确认所有 `dailyforge-*` 任务均为 `active = false`。
2. 等待 CPU、Memory、IOwait、Database Errors 和 API Gateway Errors 恢复正常；期间不运行健康探测、清理或生成任务。
3. 资源稳定后执行 [`supabase/heartbeat.sql`](supabase/heartbeat.sql)，它会删除所有遗留 DailyForge Cron，并只创建一条 `dailyforge-online-heartbeat`。
4. 先运行一条任务、一个 Worker、低并发验证。指标继续稳定后才恢复飞书中的定时计划。

历史 Supabase 表的索引审查见 [`SUPABASE_INDEX_RECOMMENDATIONS.md`](SUPABASE_INDEX_RECOMMENDATIONS.md)。当前架构不使用这些表，不应在故障恢复期间创建索引。

## 服务端接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 检查 AI、飞书和定时密钥是否配置 |
| `GET /api/dashboard` | 读取飞书任务、结果和计划，需管理登录 |
| `POST /api/cron/tick` | 在线定时心跳，需 `CRON_SECRET` |
| `POST /api/worker/run` | 单独推进一个任务阶段，需 `WORKER_SECRET` |
| `POST /api/manual/generate` | 从运行台手动创建任务 |
| `POST /api/manual/run-worker` | 从运行台手动推进一步 |
| `POST /api/manual/retry` | 重试失败任务 |
| `GET/POST/PATCH/DELETE /api/schedules` | 管理飞书定时计划 |
| `GET/PUT /api/settings/prompts` | 读取或保存飞书提示词 |
| `GET/POST/PATCH /api/admin/devices` | 创建连接码并管理运营电脑 |
| `POST /api/device/pair` | 运营电脑用一次性连接码换取设备凭证 |
| `POST /api/device/social/claim` | 执行设备领取一条飞书内容 |
| `POST /api/device/social/report` | 回写小红书和抖音草稿结果 |

运行台和管理接口使用 `ADMIN_ACCESS_KEY` 登录；设备凭证仅保存在对应 Windows 用户的 DPAPI 加密文件中。公开部署仍建议保留 Vercel 自带的访问日志和异常告警。

云端生成不依赖运营电脑；但把飞书成品建立成社媒草稿时，指定的运营电脑必须开机、Chrome 已登录两个平台、本机助手正在运行。

## 验证

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

真实飞书验收顺序见 [`docs/acceptance-checklist.md`](docs/acceptance-checklist.md)。
