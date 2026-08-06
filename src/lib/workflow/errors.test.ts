import { describe, expect, it } from "vitest";
import {
  classifyWorkflowError,
  httpError,
  retryDelayMs,
} from "@/lib/workflow/errors";

describe("workflow errors", () => {
  it("retries rate limits and upstream failures", () => {
    expect(httpError("AI", 429, "rate limited").retryable).toBe(true);
    expect(httpError("AI", 503, "offline").retryable).toBe(true);
    expect(httpError("AI", 401, "bad key").retryable).toBe(false);
  });

  it("uses 1, 5 and 15 minute backoff", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(300_000);
    expect(retryDelayMs(3)).toBe(900_000);
    expect(retryDelayMs(8)).toBe(900_000);
  });

  it("classifies network TypeErrors as retryable", () => {
    expect(classifyWorkflowError(new TypeError("fetch failed")).retryable).toBe(true);
  });
});
