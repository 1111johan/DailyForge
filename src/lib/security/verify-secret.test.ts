import { afterEach, describe, expect, it } from "vitest";
import {
  assertBearerSecret,
  secretsMatch,
  UnauthorizedError,
} from "@/lib/security/verify-secret";

describe("endpoint secret verification", () => {
  afterEach(() => delete process.env.WORKER_SECRET);

  it("uses exact constant-time compatible comparison", () => {
    expect(secretsMatch("same-secret", "same-secret")).toBe(true);
    expect(secretsMatch("short", "different-length")).toBe(false);
  });

  it("accepts only the configured bearer token", () => {
    process.env.WORKER_SECRET = "correct-secret";
    const valid = new Request("https://example.test", {
      headers: { Authorization: "Bearer correct-secret" },
    });
    expect(() => assertBearerSecret(valid, "WORKER_SECRET")).not.toThrow();

    const invalid = new Request("https://example.test", {
      headers: { Authorization: "Bearer wrong-secret" },
    });
    expect(() => assertBearerSecret(invalid, "WORKER_SECRET")).toThrow(UnauthorizedError);
  });
});
