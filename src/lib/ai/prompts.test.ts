import { describe, expect, it } from "vitest";
import { buildPostUserPrompt } from "@/lib/ai/prompts";
import type { ContentTopic, Product } from "@/lib/types/domain";

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
