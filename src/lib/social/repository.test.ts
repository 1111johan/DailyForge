import { describe, expect, it } from "vitest";
import type { FeishuRecord } from "@/lib/feishu/bitable";
import {
  defaultSocialState,
  recoverExpiredSocialClaim,
  socialAttachments,
  socialStateFromRecord,
} from "@/lib/social/repository";

function record(fields: Record<string, unknown>): FeishuRecord {
  return { record_id: "rec_test", fields };
}

describe("social repository helpers", () => {
  it("prefers the unified image field and limits a draft to four images", () => {
    const attachments = socialAttachments(record({
      "图片": [1, 2, 3, 4, 5].map((index) => ({
        file_token: `unified-${index}`,
        name: `${index}.png`,
      })),
      "图片1": [{ file_token: "legacy-1" }],
    }));

    expect(attachments.map((item) => item.file_token)).toEqual([
      "unified-1",
      "unified-2",
      "unified-3",
      "unified-4",
    ]);
    expect(attachments.map((item) => item.index)).toEqual([1, 2, 3, 4]);
  });

  it("falls back to legacy image fields and ignores entries without tokens", () => {
    const attachments = socialAttachments(record({
      "图片": [{ file_token: "only-one" }],
      "图片1": [{ file_token: "legacy-1" }],
      "图片2": [{ name: "missing-token.png" }],
      "图片3": [{ file_token: "legacy-3" }],
      "图片4": [{ file_token: "legacy-4" }],
    }));

    expect(attachments.map((item) => item.file_token)).toEqual([
      "legacy-1",
      "legacy-3",
      "legacy-4",
    ]);
  });

  it("restores completed platform fields when stored JSON is unavailable", () => {
    const source = record({
      "社媒数据": "not-json",
      "小红书草稿状态": "草稿完成",
      "抖音草稿状态": "等待建立",
    });

    expect(socialStateFromRecord(source)).toMatchObject({
      lockedBy: null,
      lockedAt: null,
      platforms: {
        xiaohongshu: { status: "draft_ready", attempts: 0, error: null },
        douyin: { status: "pending", attempts: 0, error: null },
      },
    });
    expect(defaultSocialState(source).version).toBe(1);
  });

  it("returns expired in-progress platforms to the pending queue", () => {
    const state = defaultSocialState();
    state.lockedBy = "device-old";
    state.lockedAt = new Date(Date.now() - 21 * 60_000).toISOString();
    state.platforms.xiaohongshu.status = "processing";
    state.platforms.douyin.status = "draft_ready";

    expect(recoverExpiredSocialClaim(state)).toMatchObject({
      lockedBy: null,
      lockedAt: null,
      platforms: {
        xiaohongshu: { status: "pending" },
        douyin: { status: "draft_ready" },
      },
    });
  });
});
