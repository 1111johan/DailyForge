import { ConfigurationError } from "@/lib/config/env";

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowError";
  }
}

export function classifyWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  if (error instanceof ConfigurationError) {
    return new WorkflowError(error.message, "CONFIGURATION_ERROR", false, {
      cause: error,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new WorkflowError("Upstream request timed out", "UPSTREAM_TIMEOUT", true, {
      cause: error,
    });
  }
  if (error instanceof TypeError) {
    return new WorkflowError(error.message, "NETWORK_ERROR", true, {
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : "Unknown workflow error";
  return new WorkflowError(message, "UNEXPECTED_ERROR", true, {
    cause: error instanceof Error ? error : undefined,
  });
}

export function retryDelayMs(attempt: number) {
  const delays = [60_000, 5 * 60_000, 15 * 60_000];
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)];
}

export function httpError(
  service: string,
  status: number,
  body: string,
): WorkflowError {
  const retryable = status === 408 || status === 429 || status >= 500;
  return new WorkflowError(
    `${service} returned ${status}: ${body.slice(0, 800)}`,
    `${service.toUpperCase()}_HTTP_${status}`,
    retryable,
  );
}
