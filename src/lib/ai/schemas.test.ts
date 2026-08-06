import { describe, expect, it } from "vitest";
import { GeneratedPostSchema } from "@/lib/ai/schemas";
import { validGeneratedPost } from "@/test/fixtures";

describe("GeneratedPostSchema", () => {
  it("accepts a complete four-image post", () => {
    expect(GeneratedPostSchema.parse(validGeneratedPost()).image_briefs).toHaveLength(4);
  });

  it("rejects a title that is not in the candidate list", () => {
    const value = { ...validGeneratedPost(), selected_title: "一个不存在的候选标题" };
    expect(GeneratedPostSchema.safeParse(value).success).toBe(false);
  });

  it("rejects duplicated image indexes", () => {
    const value = validGeneratedPost();
    const imageBriefs = value.image_briefs.map((brief, index) =>
      index === 3 ? { ...brief, index: 3 } : brief,
    );
    expect(GeneratedPostSchema.safeParse({ ...value, image_briefs: imageBriefs }).success).toBe(false);
  });

  it("rejects a body longer than 1000 characters", () => {
    const value = { ...validGeneratedPost(), body: "字".repeat(1001) };
    expect(GeneratedPostSchema.safeParse(value).success).toBe(false);
  });
});
