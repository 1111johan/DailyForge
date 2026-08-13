import { describe, expect, it } from "vitest";
import {
  CONTENT_STATE_FIELD,
  parseContentState,
  stateFields,
  type FeishuContentState,
} from "@/lib/feishu/content-state";

describe("Feishu content state", () => {
  const state = {
    version: 1,
    job: {
      id: "job-1",
      status: "queued",
      stage: "generate_copy",
      run_after: "2026-08-13T01:00:00.000Z",
      locked_at: null,
    },
    post: null,
    assets: [],
  } as unknown as FeishuContentState;

  it("round trips the complete workflow state", () => {
    const fields = stateFields(state);
    const parsed = parseContentState({
      record_id: "rec123",
      fields,
    });
    expect(parsed?.recordId).toBe("rec123");
    expect(parsed?.job.id).toBe("job-1");
    expect(fields["系统状态"]).toBe("queued");
    expect(fields["下次执行"]).toBe(
      new Date("2026-08-13T01:00:00.000Z").getTime(),
    );
  });

  it("ignores historical rows without workflow state", () => {
    expect(
      parseContentState({ record_id: "old", fields: { [CONTENT_STATE_FIELD]: "" } }),
    ).toBeNull();
  });

  it("parses rich-text fragments returned by Feishu list APIs", () => {
    const fields = stateFields(state);
    const parsed = parseContentState({
      record_id: "rec-rich-text",
      fields: {
        ...fields,
        [CONTENT_STATE_FIELD]: [
          { type: "text", text: fields[CONTENT_STATE_FIELD] },
        ],
      },
    });
    expect(parsed?.job.id).toBe("job-1");
  });
});
