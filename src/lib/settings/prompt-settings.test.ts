import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_SETTINGS,
  PromptSettingsSchema,
} from "@/lib/settings/prompt-settings-schema";

describe("prompt settings", () => {
  it("ships valid CET4/CET6 Xiaohongshu defaults", () => {
    expect(PromptSettingsSchema.parse(DEFAULT_PROMPT_SETTINGS)).toEqual(
      DEFAULT_PROMPT_SETTINGS,
    );
    expect(DEFAULT_PROMPT_SETTINGS.copyPrompt).toContain("准大一新生");
    expect(DEFAULT_PROMPT_SETTINGS.copyPrompt).toContain("六级");
    expect(DEFAULT_PROMPT_SETTINGS.copyPrompt).toContain("1000");
    expect(DEFAULT_PROMPT_SETTINGS.imagePrompt).toContain("四张");
    expect(DEFAULT_PROMPT_SETTINGS.imagePrompt).toContain("高饱和深蓝色");
    expect(DEFAULT_PROMPT_SETTINGS.imagePrompt).toContain("手工拼贴海报风");
    expect(DEFAULT_PROMPT_SETTINGS.imagePrompt).toContain("不得为凑数量新增文案");
    expect(DEFAULT_PROMPT_SETTINGS.imagePrompt).not.toContain("六级阅读总是看不懂");
  });

  it("rejects an empty prompt", () => {
    expect(
      PromptSettingsSchema.safeParse({ copyPrompt: "", imagePrompt: "图片" })
        .success,
    ).toBe(false);
  });
});
