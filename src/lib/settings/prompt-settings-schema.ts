import { z } from "zod";

export const PROMPT_SETTINGS_KEY = "xiaohongshu_generation_prompts";

export const DEFAULT_PROMPT_SETTINGS = {
  copyPrompt: `围绕大学英语四六级备考写一篇可直接发布的小红书笔记。

选题方向：
- 四级内容优先面向准大一新生和大一学生，帮助他们从入学起尽早准备四级，解决不知道从哪里开始、学习顺序混乱、容易拖延的问题。
- 六级内容面向已经通过四级或正在准备六级的大学生，重点讲清六级与四级的差异、分项提升方法、复习节奏和错题复盘。

写作要求：
1. 标题具体、有真实痛点，不夸张承诺，不使用培训机构口吻。
2. 正文像学长学姐的经验分享，先指出问题，再给可执行步骤，并自然说明资料如何配合学习。
3. 正文控制在500至900个中文字符，绝不能超过1000字符。
4. 四级和六级内容严格区分，避免空泛鸡汤、硬广和资料堆砌感。
5. 结尾给出适合人群和下一步行动，并附相关小红书话题标签。`,
  imagePrompt: `同一篇笔记的四张图保持深蓝底手工拼贴学习海报风，重点保证小红书封面感、大学生学习博主风、视觉冲击力与收藏价值。严格使用本次提供的考试级别、主题、标题、副标题和要点，不套用示例文案，也不为凑卡片数量新增文字。`,
} as const;

export const PromptSettingsSchema = z.object({
  copyPrompt: z.string().trim().min(1, "文案提示词不能为空").max(5000),
  imagePrompt: z.string().trim().min(1, "图片提示词不能为空").max(5000),
});

export type PromptSettings = z.infer<typeof PromptSettingsSchema>;
