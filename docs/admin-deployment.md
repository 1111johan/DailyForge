# 管理员部署手册

## 交付边界

- Vercel 运行 DailyForge 管理台、计划调度接口和设备接口。
- 飞书保存所有业务内容、图片、计划、提示词和设备状态。
- Supabase 只负责每分钟唤醒一次云端任务，不保存业务数据。
- 运营电脑使用公司统一的 DailyForge 地址和一次性连接码，不获得任何服务端密钥。
- 小红书、抖音最终发布始终由运营人员手动点击。

## 第一次部署

1. 在飞书开放平台创建企业自建应用，给应用多维表格读取和编辑能力，并把应用加入目标多维表格的协作者。
2. 从 `.env.example` 创建 `.env.local`，填写 AI、飞书、定时和管理口令。
3. 执行 `npm run setup:feishu`。脚本会补齐内容表字段，并返回计划表、设置表和运营设备表 ID。
4. 把返回值写入 `FEISHU_SCHEDULE_TABLE_ID`、`FEISHU_SETTINGS_TABLE_ID`、`FEISHU_DEVICE_TABLE_ID`。
5. 在 Vercel 项目中配置同名 Production 环境变量，执行生产部署。
6. 访问 `/api/health`，确认 `ai`、`feishu`、`security` 均为 `true`。
7. 按 `supabase/heartbeat.sql` 安装唯一的云端心跳。Supabase 资源异常时先执行 `supabase/emergency-stop.sql`。

三个保护值必须不同：

- `ADMIN_ACCESS_KEY`：管理员登录运行台。
- `CRON_SECRET`：Supabase 调用 `/api/cron/tick`。
- `WORKER_SECRET`：服务端单步 Worker 接口。

## 制作运营电脑安装包

构建电脑需要已安装 Node.js 20.9+ 和 Python 3.12；Chrome 控制组件已经收进本仓库。执行：

```powershell
npm run package:companion
```

产物：

- `artifacts/operator-package/DailyForge-Operator.zip`
- 命令输出中的 SHA-256，用于交付前核对文件完整性。

安装包内自带 Node、精简 Python 运行环境和 Chrome 控制组件。运营电脑不需要另外安装开发工具。

## 添加运营电脑

1. 登录 DailyForge 运行台。
2. 在“运营电脑”输入易识别的名称，例如“内容组-小王”。
3. 点击“添加电脑”，把 20 分钟有效的一次性连接码发给对应运营人员。
4. 第一台启用的电脑自动成为执行设备；有多台电脑时，只指定一台执行，其他作为备用。
5. 电脑停用后，它的设备凭证立即失效；重新启用不会自动恢复已删除的本地凭证，需要创建新的设备记录或连接码。

## 更新和回滚

- 更新：重新构建安装包并让运营人员再次运行安装程序；设备连接文件和图片缓存会保留。
- 回滚云端：在 Vercel 选择上一成功部署，飞书数据无需迁移。
- 回滚本机：重新安装上一版本安装包。
- 禁用自动草稿：在运行台停用执行设备，不影响云端生成和飞书内容。
