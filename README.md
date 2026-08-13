# DailyForge Lite

DailyForge Lite 是一条面向小红书图文的在线内容生产流水线：按计划创建任务、调用 AI 中转站生成文案和 4 张图片，并把任务状态与最终成果直接保存到飞书多维表格。用户电脑无需保持开机，发布仍由人工完成。

## 当前能力

- 四级内容优先面向准大一、大一新生，六级内容面向大学生进阶备考。
- 文案包含标题、正文和横向排列的话题标签，正文不超过 1000 字。
- 每篇生成 4 张 1024x1536 图片，统一保存在一个飞书附件字段。
- 提示词和定时计划可在运行台修改，保存后写入飞书。
- 同一批次使用确定性任务 ID，重复触发不会重复创建。
- 每条任务之间随机等待 1 至 9 秒，图片任务最多同时进行 2 个。
- 每个生成阶段可恢复、可重试；过期任务锁会自动回收。
- AI 图片验证后直接上传飞书，不保存数据库或对象存储副本。

## 数据结构

一个飞书多维表格应用包含三张数据表：

- 内容表：文案、图片、审核结果和内部任务状态。
- `DailyForge 定时计划`：执行时间、星期、条数、四六级模式。
- `DailyForge 系统设置`：文案提示词和图片提示词。

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

# 在线定时接口保护
CRON_SECRET=
WORKER_SECRET=

DEFAULT_PLATFORM=xiaohongshu
DAILY_GENERATION_COUNT=1
APP_TIMEZONE=Asia/Shanghai
```

`npm run setup:feishu` 会在内容表补齐内部字段，并幂等创建计划表和设置表。脚本不会修改或删除历史内容。

## 在线自动执行

部署到 Vercel 后，由外部分钟级定时器每分钟发送一次：

```text
POST https://YOUR_DOMAIN/api/cron/tick
Authorization: Bearer YOUR_CRON_SECRET
```

一次心跳会先检查到期计划，再推进一个待处理阶段。接口与飞书任务 ID 都具备幂等保护，重复请求不会重复创建同一批内容。

## 服务端接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 检查 AI、飞书和定时密钥是否配置 |
| `GET /api/dashboard` | 读取飞书任务、结果和计划 |
| `POST /api/cron/tick` | 在线定时心跳，需 `CRON_SECRET` |
| `POST /api/worker/run` | 单独推进一个任务阶段，需 `WORKER_SECRET` |
| `POST /api/manual/generate` | 从运行台手动创建任务 |
| `POST /api/manual/run-worker` | 从运行台手动推进一步 |
| `POST /api/manual/retry` | 重试失败任务 |
| `GET/POST/PATCH/DELETE /api/schedules` | 管理飞书定时计划 |
| `GET/PUT /api/settings/prompts` | 读取或保存飞书提示词 |

运行台与手动接口没有应用内登录。公开部署时应启用 Vercel Deployment Protection 或等效访问保护。

## 验证

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

真实飞书验收顺序见 [`docs/acceptance-checklist.md`](docs/acceptance-checklist.md)。
