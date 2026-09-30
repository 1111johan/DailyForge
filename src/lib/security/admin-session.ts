import { createHmac, timingSafeEqual } from "node:crypto";
import { getSecret } from "@/lib/config/env";
import { UnauthorizedError } from "@/lib/security/verify-secret";

export const ADMIN_SESSION_COOKIE = "dailyforge_admin";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function signature(expiresAt: number) {
  return createHmac("sha256", getSecret("ADMIN_ACCESS_KEY"))
    .update(`dailyforge-admin:${expiresAt}`)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function createAdminSession(now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return `${expiresAt}.${signature(expiresAt)}`;
}

export function verifyAdminSession(value: string | undefined, now = Date.now()) {
  if (!value) return false;
  const [expiresText, receivedSignature, extra] = value.split(".");
  if (!expiresText || !receivedSignature || extra) return false;
  const expiresAt = Number(expiresText);
  if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) {
    return false;
  }
  return safeEqual(receivedSignature, signature(expiresAt));
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function assertSameOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).origin !== new URL(request.url).origin) {
    throw new UnauthorizedError();
  }
}

export function assertAdminRequest(request: Request) {
  assertSameOrigin(request);
  if (!verifyAdminSession(cookieValue(request, ADMIN_SESSION_COOKIE))) {
    throw new UnauthorizedError();
  }
}

export function adminCookie(value: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function expiredAdminCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}
