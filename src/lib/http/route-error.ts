import { NextResponse } from "next/server";
import { ConfigurationError } from "@/lib/config/env";
import { UnauthorizedError } from "@/lib/security/verify-secret";
import { WorkflowError, classifyWorkflowError } from "@/lib/workflow/errors";

export function routeError(error: unknown) {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "接口密钥无效" } },
      { status: 401 },
    );
  }
  if (error instanceof ConfigurationError) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "CONFIGURATION_ERROR", message: error.message },
      },
      { status: 503 },
    );
  }
  const classified =
    error instanceof WorkflowError ? error : classifyWorkflowError(error);
  const status =
    classified.code.endsWith("NOT_FOUND")
      ? 404
      : classified.retryable
        ? 503
        : 422;
  return NextResponse.json(
    {
      ok: false,
      error: { code: classified.code, message: classified.message },
    },
    { status },
  );
}
