import { describe, expect, it } from "vitest";
import {
  buildStaggerOffsets,
  dateInTimeZone,
  repeatBalanced,
} from "@/lib/workflow/create-job";

describe("daily job date", () => {
  it("uses the configured business timezone", () => {
    const date = new Date("2026-08-06T16:30:00Z");
    expect(dateInTimeZone(date, "Asia/Shanghai")).toBe("2026-08-07");
  });

  it("spaces tasks by a cumulative random 1 to 9 seconds", () => {
    const samples = [0, 0.5, 0.999];
    let index = 0;
    expect(buildStaggerOffsets(4, () => samples[index++])).toEqual([0, 1, 6, 15]);
  });

  it("rotates products across the requested batch size", () => {
    expect(repeatBalanced(["cet4", "cet6"], 5)).toEqual([
      "cet4",
      "cet6",
      "cet4",
      "cet6",
      "cet4",
    ]);
  });
});
