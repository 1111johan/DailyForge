import { timingSafeEqual } from "node:crypto";
import { getSecret, type SecretName } from "@/lib/config/env";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export function secretsMatch(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function assertBearerSecret(request: Request, name: SecretName) {
  const authorization = request.headers.get("authorization") || "";
  const received = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!received || !secretsMatch(received, getSecret(name))) {
    throw new UnauthorizedError();
  }
}
