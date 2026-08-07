import { describe, expect, it } from "vitest";
import {
  bodyWithHashtags,
  buildFeishuFields,
  jobDateMilliseconds,
} from "@/lib/feishu/fields";
import { validGeneratedPost } from "@/test/fixtures";

describe("Feishu field mapping", () => {
  it("converts a China-local date to milliseconds", () => {
    expect(jobDateMilliseconds("2026-08-07")).toBe(
      new Date("2026-08-07T00:00:00+08:00").getTime(),
    );
  });

  it("places hashtags below the body on one line", () => {
    expect(bodyWithHashtags("正文内容  ", ["#四级备考", "#英语学习"])).toBe(
      "正文内容\n\n#四级备考 #英语学习",
    );
  });

  it("maps four file tokens to one ordered attachment field", () => {
    const content = validGeneratedPost();
    const fields = buildFeishuFields({
      job: { id: "job-1", job_date: "2026-08-07" } as never,
      product: { name: "四级资料", level: "cet4" } as never,
      topic: { module: "全科" } as never,
      post: { id: "post-1", review_status: "approved" } as never,
      content: content as never,
      assets: [3, 1, 4, 2].map((index) => ({
        asset_index: index,
        feishu_file_token: `token-${index}`,
      })) as never,
    });

    expect(fields["正文"]).toBe(
      `${content.body}\n\n${content.hashtags.join(" ")}`,
    );
    expect(fields["话题标签"]).toBeUndefined();
    expect(fields["图片"]).toEqual(
      [1, 2, 3, 4].map((index) => ({ file_token: `token-${index}` })),
    );
    expect(fields["图片1"]).toBeUndefined();
    expect(fields["图片4"]).toBeUndefined();
    expect(fields["级别"]).toBe("四级");
  });
});
