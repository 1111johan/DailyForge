import { describe, expect, it } from "vitest";
import { buildFeishuFields, jobDateMilliseconds } from "@/lib/feishu/fields";
import { validGeneratedPost } from "@/test/fixtures";

describe("Feishu field mapping", () => {
  it("converts a China-local date to milliseconds", () => {
    expect(jobDateMilliseconds("2026-08-07")).toBe(
      new Date("2026-08-07T00:00:00+08:00").getTime(),
    );
  });

  it("maps four file tokens to ordered attachment fields", () => {
    const content = validGeneratedPost();
    const fields = buildFeishuFields({
      job: { id: "job-1", job_date: "2026-08-07" } as never,
      product: { name: "四级资料", level: "cet4" } as never,
      topic: { module: "全科" } as never,
      post: { id: "post-1", review_status: "approved" } as never,
      content: content as never,
      assets: [1, 2, 3, 4].map((index) => ({
        asset_index: index,
        feishu_file_token: `token-${index}`,
      })) as never,
    });

    expect(fields["图片1"]).toEqual([{ file_token: "token-1" }]);
    expect(fields["图片4"]).toEqual([{ file_token: "token-4" }]);
    expect(fields["级别"]).toBe("四级");
  });
});
