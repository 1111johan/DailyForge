import { getAiConfig } from "@/lib/config/env";
import {
  httpError,
  WorkflowError,
} from "@/lib/workflow/errors";
import type {
  AiCallObservation,
  AiCallObserver,
  AiCallType,
  AiGateway,
  ImageGenerateInput,
  ImageGenerateResult,
  TextGenerateInput,
} from "@/lib/ai/types";

type JsonObject = Record<string, unknown>;

interface RelayResponse {
  body: JsonObject;
  latencyMs: number;
  requestId?: string;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function number(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function stripCodeFence(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly rawOutput: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export class OpenAiCompatibleGateway implements AiGateway {
  private readonly config = getAiConfig();

  constructor(private readonly observer?: AiCallObserver) {}

  private async notify(observation: AiCallObservation) {
    try {
      await this.observer?.(observation);
    } catch {
      // Model logging must never turn a successful generation into a failed job.
    }
  }

  private async fetchJson(
    path: string,
    init: RequestInit,
    service: string,
  ): Promise<RelayResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
      const textBody = await response.text();

      if (!response.ok) {
        throw httpError(service, response.status, textBody);
      }

      let body: JsonObject;
      try {
        body = JSON.parse(textBody) as JsonObject;
      } catch (error) {
        throw new WorkflowError(
          `${service} returned invalid JSON`,
          `${service.toUpperCase()}_INVALID_JSON`,
          false,
          { cause: error },
        );
      }

      return {
        body,
        latencyMs: Date.now() - startedAt,
        requestId:
          response.headers.get("x-request-id") || string(body.id) || undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async generateJson<T>(input: TextGenerateInput<T>): Promise<T> {
    const maxRepairs = input.maxRepairAttempts ?? 2;
    let previousOutput = "";
    let previousError = "";

    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      const startedAt = Date.now();
      let relay: RelayResponse | undefined;
      try {
        const repairInstruction =
          attempt === 0
            ? input.userPrompt
            : `${input.userPrompt}\n\n上一次输出不符合要求。错误：${previousError}\n请重新输出完整且合法的 JSON，不要输出 Markdown。上一次输出仅供纠错：\n${previousOutput.slice(0, 12000)}`;

        relay = await this.fetchJson(
          this.config.textPath,
          {
            method: "POST",
            body: JSON.stringify({
              model: this.config.textModel,
              messages: [
                { role: "system", content: input.systemPrompt },
                { role: "user", content: repairInstruction },
              ],
              temperature: input.temperature ?? 0.8,
              response_format: { type: "json_object" },
            }),
          },
          "AI_TEXT",
        );

        const choices = Array.isArray(relay.body.choices)
          ? relay.body.choices
          : [];
        const firstChoice = object(choices[0]);
        const message = object(firstChoice?.message);
        const content = string(message?.content);
        if (!content) {
          throw new StructuredOutputError(
            "AI relay returned empty text content",
            "",
          );
        }

        previousOutput = content;
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFence(content));
        } catch {
          throw new StructuredOutputError("AI output is not valid JSON", content);
        }

        const validated = input.schema.safeParse(parsed);
        if (!validated.success) {
          throw new StructuredOutputError(
            validated.error.issues
              .slice(0, 8)
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
            content,
          );
        }

        const usage = object(relay.body.usage);
        await this.notify({
          callType: "text",
          model: this.config.textModel,
          provider: "openai-compatible",
          requestId: relay.requestId,
          inputTokens: number(usage?.prompt_tokens),
          outputTokens: number(usage?.completion_tokens),
          latencyMs: relay.latencyMs,
          status: "success",
        });
        return validated.data;
      } catch (error) {
        previousError = error instanceof Error ? error.message : "Unknown error";
        if (error instanceof StructuredOutputError) {
          previousOutput = error.rawOutput;
        }
        await this.notify({
          callType: "text",
          model: this.config.textModel,
          provider: "openai-compatible",
          requestId: relay?.requestId,
          latencyMs: relay?.latencyMs ?? Date.now() - startedAt,
          status: "error",
          errorMessage: previousError.slice(0, 1000),
        });

        if (error instanceof StructuredOutputError && attempt < maxRepairs) {
          continue;
        }
        if (error instanceof StructuredOutputError) {
          throw new WorkflowError(
            `AI output failed schema validation after ${maxRepairs + 1} attempts: ${error.message}`,
            "AI_SCHEMA_INVALID",
            false,
            { cause: error },
          );
        }
        throw error;
      }
    }

    throw new WorkflowError(
      "AI structured output failed",
      "AI_SCHEMA_INVALID",
      false,
    );
  }

  private async downloadImage(url: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw httpError("AI_IMAGE_DOWNLOAD", response.status, await response.text());
      }
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || "image/png",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseImageResponse(
    body: JsonObject,
    requestId?: string,
  ): Promise<ImageGenerateResult> {
    const data = Array.isArray(body.data) ? body.data : [];
    const candidate = object(data[0]) || object(body.data) || body;
    const base64 = string(candidate.b64_json) || string(candidate.image_base64);
    if (base64) {
      return {
        status: "ready",
        buffer: Buffer.from(base64.replace(/^data:[^;]+;base64,/, ""), "base64"),
        mimeType: string(candidate.mime_type) || "image/png",
        requestId,
      };
    }

    const url = string(candidate.url) || string(candidate.image_url);
    if (url) {
      const downloaded = await this.downloadImage(url);
      return { status: "ready", ...downloaded, requestId };
    }

    const status = (string(body.status) || string(candidate.status) || "").toLowerCase();
    const taskId =
      string(body.task_id) ||
      string(candidate.task_id) ||
      (["queued", "pending", "processing", "running"].includes(status)
        ? string(candidate.id)
        : undefined);
    if (taskId && !["failed", "error", "cancelled"].includes(status)) {
      return { status: "pending", taskId, requestId };
    }

    throw new WorkflowError(
      "AI image relay returned neither image data nor a task id",
      "AI_IMAGE_INVALID_RESPONSE",
      false,
    );
  }

  private async observedImageCall(
    callType: AiCallType,
    model: string,
    path: string,
    init: RequestInit,
  ) {
    const startedAt = Date.now();
    let relay: RelayResponse | undefined;
    try {
      relay = await this.fetchJson(path, init, "AI_IMAGE");
      const result = await this.parseImageResponse(relay.body, relay.requestId);
      await this.notify({
        callType,
        model,
        provider: "openai-compatible",
        requestId: relay.requestId,
        latencyMs: relay.latencyMs,
        status: "success",
      });
      return result;
    } catch (error) {
      await this.notify({
        callType,
        model,
        provider: "openai-compatible",
        requestId: relay?.requestId,
        latencyMs: relay?.latencyMs ?? Date.now() - startedAt,
        status: "error",
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
      });
      throw error;
    }
  }

  generateImage(input: ImageGenerateInput) {
    return this.observedImageCall(
      "image",
      this.config.imageModel,
      this.config.imagePath,
      {
        method: "POST",
        body: JSON.stringify({
          model: this.config.imageModel,
          prompt: input.prompt,
          size: `${input.width}x${input.height}`,
          n: 1,
          response_format: "b64_json",
        }),
      },
    );
  }

  pollImageTask(taskId: string) {
    const path = this.config.imagePollPath.replace(
      "{taskId}",
      encodeURIComponent(taskId),
    );
    return this.observedImageCall(
      "image_poll",
      this.config.imageModel,
      path,
      { method: "GET" },
    );
  }
}

export function createAiGateway(observer?: AiCallObserver): AiGateway {
  return new OpenAiCompatibleGateway(observer);
}
