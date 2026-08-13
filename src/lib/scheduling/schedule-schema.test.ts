import { describe, expect, it } from "vitest";
import {
  ScheduleInputSchema,
  SchedulePatchSchema,
} from "@/lib/scheduling/schedule-schema";
import { nextScheduleAt } from "@/lib/scheduling/repository";

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

  it("calculates the next run in Shanghai time across UTC day boundaries", () => {
    expect(
      nextScheduleAt("09:00", [4], new Date("2026-08-13T00:30:00.000Z")),
    ).toBe("2026-08-13T01:00:00.000Z");
    expect(
      nextScheduleAt("08:00", [7], new Date("2026-08-15T16:30:00.000Z")),
    ).toBe("2026-08-16T00:00:00.000Z");
  });
});
