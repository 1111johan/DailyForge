import { describe, expect, it } from "vitest";
import { dateInTimeZone } from "@/lib/workflow/create-job";

describe("daily job date", () => {
  it("uses the configured business timezone", () => {
    const date = new Date("2026-08-06T16:30:00Z");
    expect(dateInTimeZone(date, "Asia/Shanghai")).toBe("2026-08-07");
  });
});
