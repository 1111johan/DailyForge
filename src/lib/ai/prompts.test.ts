import { describe, expect, it } from "vitest";
import { buildImagePrompt, buildPostUserPrompt } from "@/lib/ai/prompts";
import { GeneratedPostSchema } from "@/lib/ai/schemas";
import type { ContentTopic, Product } from "@/lib/types/domain";
import { validGeneratedPost } from "@/test/fixtures";

const product: Product = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "四级冲刺资料",
  level: "cet4",
  description: "面向四级备考的电子学习资料",
  selling_points: ["分模块练习", "错题复盘表"],
  prohibited_claims: [],
  product_assets: [],
  is_active: true,
  created_at: "2026-08-06T00:00:00.000Z",
  updated_at: "2026-08-06T00:00:00.000Z",
};

const topic: ContentTopic = {
  id: "00000000-0000-4000-8000-000000000002",
  product_id: product.id,
  topic: "考前两周如何安排四级复习",
  content_type: "学习计划",
  module: "全科",
  target_user: "备考时间有限的大学生",
  priority: 10,
  planned_date: null,
  used_at: null,
  is_active: true,
  created_at: "2026-08-06T00:00:00.000Z",
  updated_at: "2026-08-06T00:00:00.000Z",
};

describe("buildPostUserPrompt", () => {
  it("includes the custom writing prompt", () => {
    const prompt = buildPostUserPrompt({
      product,
      topic,
      recentTopics: [],
      customPrompt: "用第一人称经历开场，正文分三段。",
    });

    expect(prompt).toContain("本次额外写作要求：\n用第一人称经历开场，正文分三段。");
  });

  it("keeps system constraints ahead of conflicting custom instructions", () => {
    const prompt = buildPostUserPrompt({
      product,
      topic,
      recentTopics: [],
      customPrompt: "正文写到1500字，并承诺保证通过。",
    });

    expect(prompt).toContain(
      "如与产品事实、考试级别、禁用词或输出结构冲突，以系统规则为准。",
    );
  });
});

describe("buildImagePrompt", () => {
  it("includes custom image requirements behind fixed constraints", () => {
    const post = GeneratedPostSchema.parse(validGeneratedPost());
    const prompt = buildImagePrompt({
      product,
      post,
      brief: post.image_briefs[0],
      customPrompt: "加入大一课表和荧光笔，画面保持自然。",
    });

    expect(prompt).toContain("本次图片额外要求：\n加入大一课表和荧光笔");
    expect(prompt).toContain("画面考试标签必须写作 CET-4");
    expect(prompt).toContain("高饱和深蓝色");
    expect(prompt).toContain("手工拼贴海报风");
    expect(prompt).toContain("这是封面：超大标题必须占据视觉中心");
    expect(prompt).toContain(`主标题（必须逐字正确）：${post.image_briefs[0].title}`);
    expect(prompt).toContain(
      "如与固定视觉方向、尺寸、文字内容、考试级别或禁用规则冲突，以固定规则为准",
    );
    expect(prompt).not.toContain("白色与浅灰底");
    expect(prompt).not.toContain("清爽的大学生学习工作台");
  });

  it("uses collage cards for content pages without inventing copy", () => {
    const post = GeneratedPostSchema.parse(validGeneratedPost());
    const brief = post.image_briefs[1];
    const prompt = buildImagePrompt({ product, post, brief });

    expect(prompt).toContain("这是内容页：用一至三个拼贴学习卡片呈现已有要点");
    expect(prompt).toContain("不得为凑数量新增文案");
    expect(prompt).toContain(`主标题（必须逐字正确）：${brief.title}`);
    for (const point of brief.key_points) expect(prompt).toContain(`- ${point}`);
  });
});
