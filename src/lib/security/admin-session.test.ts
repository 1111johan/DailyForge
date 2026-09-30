import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAdminSession,
  verifyAdminSession,
} from "@/lib/security/admin-session";

const ORIGINAL_ADMIN_ACCESS_KEY = process.env.ADMIN_ACCESS_KEY;

describe("admin session", () => {
  beforeEach(() => {
    process.env.ADMIN_ACCESS_KEY = "test-admin-access-key";
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN_ACCESS_KEY === undefined) {
      delete process.env.ADMIN_ACCESS_KEY;
    } else {
      process.env.ADMIN_ACCESS_KEY = ORIGINAL_ADMIN_ACCESS_KEY;
    }
  });

  it("accepts an untampered session before expiry", () => {
    const now = Date.UTC(2026, 8, 30, 3, 0, 0);
    const session = createAdminSession(now);

    expect(verifyAdminSession(session, now + 60_000)).toBe(true);
  });

  it("rejects expired and tampered sessions", () => {
    const now = Date.UTC(2026, 8, 30, 3, 0, 0);
    const session = createAdminSession(now);
    const expiresAt = Number(session.split(".")[0]) * 1000;

    expect(verifyAdminSession(session, expiresAt)).toBe(false);
    expect(verifyAdminSession(`${session}x`, now)).toBe(false);
  });
});
