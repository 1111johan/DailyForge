import { describe, expect, it } from "vitest";
import {
  contentSnapshotPath,
  groupStoragePaths,
} from "@/lib/maintenance/cleanup";

describe("archived content cleanup", () => {
  it("builds the persisted content snapshot path", () => {
    expect(contentSnapshotPath("2026-08-07", "post-1")).toBe(
      "2026/08/07/post-1/content.json",
    );
  });

  it("groups and deduplicates stored files by bucket", () => {
    expect(
      Object.fromEntries(
        groupStoragePaths({
          candidates: [
            { job_id: "job-1", job_date: "2026-08-07", post_id: "post-1" },
          ],
          assets: [
            { storage_bucket: "generated-content", storage_path: "image.png" },
            { storage_bucket: "generated-content", storage_path: "image.png" },
            { storage_bucket: null, storage_path: null },
          ],
          defaultBucket: "generated-content",
        }),
      ),
    ).toEqual({
      "generated-content": [
        "2026/08/07/post-1/content.json",
        "image.png",
      ],
    });
  });
});
