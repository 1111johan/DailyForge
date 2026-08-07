import { describe, expect, it } from "vitest";
import {
  ScheduleInputSchema,
  SchedulePatchSchema,
} from "@/lib/scheduling/schedule-schema";

describe("generation schedule validation", () => {
  const valid = {
    name: "每日内容",
    runTime: "08:00",
    weekdays: [7, 1, 3],
    postCount: 3,
    productMode: "rotate" as const,
    isEnabled: true,
  };

  it("normalizes selected weekdays", () => {
    expect(ScheduleInputSchema.parse(valid).weekdays).toEqual([1, 3, 7]);
  });

  it("rejects empty days and out-of-range counts", () => {
    expect(
      ScheduleInputSchema.safeParse({ ...valid, weekdays: [] }).success,
    ).toBe(false);
    expect(
      ScheduleInputSchema.safeParse({ ...valid, postCount: 21 }).success,
    ).toBe(false);
  });

  it("accepts a focused enable toggle patch", () => {
    expect(SchedulePatchSchema.parse({ isEnabled: false })).toEqual({
      isEnabled: false,
    });
  });
});
