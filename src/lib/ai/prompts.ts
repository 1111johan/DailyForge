import type { GeneratedPostContent, ImageBrief } from "@/lib/ai/schemas";
import type { ContentTopic, Product } from "@/lib/types/domain";
import { stringArray } from "@/lib/types/domain";

export const GLOBAL_PROHIBITED_CLAIMS = [
  "包过",
  "保过",
  "保证425",
  "官方内部",
  "泄题",
  "原题押中",
  "百分百提分",
];

export const POST_SYSTEM_PROMPT = `你是 DailyForge 的小红书学习内容策划。

你的任务是为大学英语四级和六级电子资料生成内容。

写作要求：
1. 像大学生真实分享，不要写成培训机构广告。
2. 开头三行必须出现明确痛点。
3. 正文目标为500至900个中文字符，绝不能少于300字符，也绝不能超过1000字符。
4. 内容必须具有实际学习方法，不得只有产品介绍。
5. 四级和六级必须严格区分。
6. 产品内容只能来自提供的产品资料，不得虚构功能。
7. 不得使用：包过、保过、保证425、官方内部、泄题、原题押中、百分百提分。
8. 必须返回一个 JSON 对象，不要返回 Markdown 或解释。
9. title_candidates 必须有3至5项，selected_title 必须从中选择。
10. hashtags 必须有5至12项，每项以#开头且不含空格。
11. image_briefs 必须恰好4项，index依次覆盖1、2、3、4，第1项type为cover。`;

export function buildPostUserPrompt(input: {
  product: Product;
  topic: ContentTopic;
  recentTopics: string[];
  customPrompt?: string;
}) {
  const { product, topic, recentTopics, customPrompt } = input;
  const level = product.level === "cet4" ? "大学英语四级" : "大学英语六级";
  const points = stringArray(product.selling_points);

  return `今日产品：${product.name}
考试级别：${level}
产品说明：${product.description}

产品实际包含内容：
${points.length > 0 ? points.map((point) => `- ${point}`).join("\n") : "- 未提供，禁止生成内容并应返回无法完成的说明"}

今日选题：${topic.topic}
内容类型：${topic.content_type}
内容模块：${topic.module || "全科"}
目标用户：${topic.target_user || "正在备考的大学生"}

最近30天已经使用的选题：
${recentTopics.length > 0 ? recentTopics.map((item, index) => `${index + 1}. ${item}`).join("\n") : "无"}

${customPrompt?.trim() ? `本次额外写作要求：\n${customPrompt.trim()}\n\n额外要求只能调整表达角度、结构和语气；如与产品事实、考试级别、禁用词或输出结构冲突，以系统规则为准。` : "本次没有额外写作要求。"}

避免重复以上标题和结构。只返回符合要求的完整 JSON。`;
}

export function buildImagePrompt(input: {
  product: Product;
  post: GeneratedPostContent;
  brief: ImageBrief;
  customPrompt?: string;
}) {
  const { product, post, brief, customPrompt } = input;
  const level = product.level === "cet4" ? "大学英语四级" : "大学英语六级";
  const prohibited = [
    ...GLOBAL_PROHIBITED_CLAIMS,
    ...stringArray(product.prohibited_claims),
    product.level === "cet4" ? "六级" : "四级",
    product.level === "cet4" ? "CET-6" : "CET-4",
  ];

  return `生成一张 2:3 竖版小红书内容图，输出尺寸必须是1024×1536。

产品：${product.name}
考试：${level}
选题：${post.topic}
图片序号：${brief.index}/4
图片类型：${brief.type === "cover" ? "封面" : "内容页"}
主标题（必须逐字正确）：${brief.title}
${brief.subtitle ? `副标题（必须逐字正确）：${brief.subtitle}` : ""}
${brief.key_points.length > 0 ? `要点：\n${brief.key_points.map((point) => `- ${point}`).join("\n")}` : ""}

视觉方向：清爽的大学生学习工作台，白色与浅灰底，深墨色正文，红色重点标记，少量绿色进度元素；使用纸张、活页夹、文具和真实学习笔记的材质，但保持信息密度清晰。禁止米黄色复古滤镜，禁止渐变、光晕、3D文字和营销海报感。

排版要求：标题层级清楚，正文中文可读，不添加任何未提供的文案、品牌、考试名称或承诺。四张图保持统一视觉系统但布局不重复。

${customPrompt?.trim() ? `本次图片额外要求：
${customPrompt.trim()}

额外要求只能调整画面风格、构图和信息呈现；如与尺寸、文字内容、考试级别或禁用规则冲突，以固定规则为准。
` : ""}

绝对禁止出现：${Array.from(new Set(prohibited)).join("、")}。`;
}
