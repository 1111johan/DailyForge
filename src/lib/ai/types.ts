import type { z } from "zod";

export type AiCallType = "text" | "image" | "image_poll" | "review";

export interface AiCallObservation {
  callType: AiCallType;
  model: string;
  provider: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  status: "success" | "error";
  errorMessage?: string;
}

export type AiCallObserver = (observation: AiCallObservation) =>
  | Promise<void>
  | void;

export interface TextGenerateInput<T> {
  schema: z.ZodType<T>;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxRepairAttempts?: number;
}

export interface ImageGenerateInput {
  prompt: string;
  width: number;
  height: number;
}

export type ImageGenerateResult =
  | {
      status: "ready";
      buffer: Buffer;
      mimeType: string;
      requestId?: string;
    }
  | {
      status: "pending";
      taskId: string;
      requestId?: string;
    };

export interface AiGateway {
  generateJson<T>(input: TextGenerateInput<T>): Promise<T>;
  generateImage(input: ImageGenerateInput): Promise<ImageGenerateResult>;
  pollImageTask(taskId: string): Promise<ImageGenerateResult>;
}
