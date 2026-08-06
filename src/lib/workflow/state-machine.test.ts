import { describe, expect, it } from "vitest";
import {
  imageIndexFromStage,
  nextStageAfterImage,
  progressForJob,
} from "@/lib/workflow/state-machine";

describe("workflow state machine", () => {
  it("continues image generation in order", () => {
    expect(nextStageAfterImage(1)).toBe("generate_image_2");
    expect(nextStageAfterImage(4)).toBe("review_content");
  });

  it("extracts both generation and polling indexes", () => {
    expect(imageIndexFromStage("generate_image_3")).toBe(3);
    expect(imageIndexFromStage("poll_image_4")).toBe(4);
    expect(imageIndexFromStage("generate_copy")).toBeNull();
  });

  it("treats polling as progress on the related image", () => {
    const progress = progressForJob({ status: "queued", stage: "poll_image_2" });
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(100);
  });
});
