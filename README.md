# DailyForge Lite

DailyForge Lite 是一条面向小红书图文的每日内容生产流水线：创建任务、生成结构化文案、逐张生成 4 张图片、保存到 Supabase，并将完整内容写入飞书多维表格。发布仍由人工完成。

## 当前范围

- 幂等创建每日任务，同一日期、平台、产品只会有一条任务。
- PostgreSQL 原子领取任务，支持并发 Worker 和 20 分钟过期锁恢复。
- 每次请求只推进一个阶段，已完成的文案和图片不会重复生成。
- 文案 JSON 经过 Zod 校验，错误输出最多自动纠正 2 次。
- 图片支持 Base64、URL 和异步 `task_id` 返回。
- 图片上传前检查文件可解码、格式、尺寸和大小。
- 飞书图片逐个复用 `file_token`，记录按“任务ID”查重。
- 可重试错误按 1、5、15 分钟退避，永久错误进入人工处理。
- 运行台可直接打开，手动任务支持为当次文案填写自定义提示词。
- 生成结果包含标题和正文，正文强制限制在 1000 个字符以内。

不包含小红书自动发布、用户账号、飞书回写、视频、订单或复杂 Agent。

## 本地启动

要求 Node.js 20.9 或更高版本。

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。没有外部服务配置时，页面仍会显示各连接的待配置状态，但不会暴露或模拟生产任务。

## 配置顺序

### 1. Supabase

1. 创建 Supabase 项目。
2. 执行 `supabase/migrations/202608060001_initial_schema.sql`。
3. 修改 `supabase/seed.sql` 中的产品事实和选题，并将确认后的记录设为 `is_active = true`。
4. 配置：

```env
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=generated-content
```

尽管变量名沿用 `NEXT_PUBLIC_SUPABASE_URL`，应用只在服务端创建 Supabase 客户端；`SUPABASE_SERVICE_ROLE_KEY` 永远不能放入浏览器代码。

### 2. AI 中转站

所需信息见 [`docs/ai-relay-contract.md`](docs/ai-relay-contract.md)。首版按 OpenAI 兼容接口发送请求，业务工作流不依赖具体模型。

### 3. 飞书

按 [`docs/feishu-setup.md`](docs/feishu-setup.md) 建立企业自建应用和多维表格。字段名称和类型必须一致，否则任务会以不可重试错误停止，等待人工修正。

### 4. 自动化密钥

生成两个不同的长随机值：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

分别填写 `CRON_SECRET` 和 `WORKER_SECRET`。它们只用于保护定时创建任务和 Worker 回调。

## 部署

1. 将项目部署到 Vercel，并填写 `.env.example` 中的环境变量。
2. 暂时不要启用 Cron。
3. 打开运行台，手动创建一条任务，并反复点击“推进一步”完成端到端验证。
4. 确认飞书内出现且只出现一条记录，4 张图片可预览。
5. 在 Supabase SQL Editor 执行 `supabase/cron.sql`。每天 08:00（Asia/Shanghai）创建任务，每分钟推进一个步骤。

`cron.sql` 使用 Supabase Vault 保存部署地址和密钥，文件内不写明文凭据。

运行台和三个 `/api/manual/*` 接口不再使用应用内密钥，适合本机或受信任的私有网络。若部署到公网，必须先启用 Vercel Deployment Protection、反向代理认证或等效的外层访问保护，否则任何能访问站点的人都可以创建、推进或重试任务。

## 状态机

```text
generate_copy
  -> generate_image_1 -> poll_image_1（仅异步接口）
  -> generate_image_2 -> poll_image_2（仅异步接口）
  -> generate_image_3 -> poll_image_3（仅异步接口）
  -> generate_image_4 -> poll_image_4（仅异步接口）
  -> review_content
  -> sync_feishu
  -> completed
```

每个阶段成功后将任务重新放回队列。下一次 Worker 调用领取并推进后续阶段。

## 服务端接口

| 接口 | 密钥 | 用途 |
| --- | --- | --- |
| `GET /api/health` | 无 | 只返回各服务是否配置，不返回配置值 |
| `GET /api/dashboard` | 无 | 读取运行台数据 |
| `POST /api/cron/create-daily-job` | `CRON_SECRET` | 幂等创建今日任务 |
| `POST /api/worker/run` | `WORKER_SECRET` | 推进一个任务阶段 |
| `POST /api/manual/generate` | 无 | 手动创建任务，可提交 `customPrompt` |
| `POST /api/manual/run-worker` | 无 | 从运行台推进一步 |
| `POST /api/manual/retry` | 无 | 重置失败任务的重试次数 |

定时任务和 Worker 的鉴权格式：`Authorization: Bearer <secret>`。

## 验证

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

数据库并发锁、Storage 和真实飞书附件需要在 Supabase/飞书测试项目中完成集成验收，不能由本地模拟替代。完整清单见 [`docs/acceptance-checklist.md`](docs/acceptance-checklist.md)。

## 目录

```text
src/app/api/       调度、Worker、运行台和手动任务接口
src/components/    运行看板
src/lib/ai/        AI Gateway、Prompt 和输出 Schema
src/lib/feishu/    Token、素材、记录和字段映射
src/lib/supabase/  服务端客户端与私有 Storage
src/lib/workflow/  状态机的各执行阶段
supabase/          数据库迁移、示例数据和 Cron
docs/              外部服务接入与验收说明
```
