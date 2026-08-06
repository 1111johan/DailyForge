import { z } from "zod";

export class ConfigurationError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing required configuration: ${missing.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

function required(names: string[]) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = z.coerce.number().int().positive().safeParse(value ?? fallback);
  return parsed.success ? parsed.data : fallback;
}

export function getSupabaseConfig() {
  required(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET || "generated-content",
  };
}

export function getAiConfig() {
  required([
    "AI_RELAY_BASE_URL",
    "AI_RELAY_API_KEY",
    "AI_TEXT_MODEL",
    "AI_IMAGE_MODEL",
  ]);

  return {
    baseUrl: process.env.AI_RELAY_BASE_URL!.replace(/\/$/, ""),
    apiKey: process.env.AI_RELAY_API_KEY!,
    textModel: process.env.AI_TEXT_MODEL!,
    imageModel: process.env.AI_IMAGE_MODEL!,
    reviewModel: process.env.AI_REVIEW_MODEL || null,
    textPath: process.env.AI_TEXT_PATH || "/v1/chat/completions",
    imagePath: process.env.AI_IMAGE_PATH || "/v1/images/generations",
    imagePollPath:
      process.env.AI_IMAGE_POLL_PATH || "/v1/images/tasks/{taskId}",
    timeoutMs: positiveInteger(process.env.AI_TIMEOUT_MS, 120_000),
    imageWidth: positiveInteger(process.env.AI_IMAGE_WIDTH, 1024),
    imageHeight: positiveInteger(process.env.AI_IMAGE_HEIGHT, 1536),
  };
}

export function getFeishuConfig() {
  required([
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_BITABLE_APP_TOKEN",
    "FEISHU_TABLE_ID",
  ]);

  return {
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN!,
    tableId: process.env.FEISHU_TABLE_ID!,
  };
}

export function getGenerationConfig() {
  return {
    platform: process.env.DEFAULT_PLATFORM || "xiaohongshu",
    dailyCount: positiveInteger(process.env.DAILY_GENERATION_COUNT, 1),
    imageCount: 4,
    timezone: process.env.APP_TIMEZONE || "Asia/Shanghai",
  };
}

export type SecretName = "CRON_SECRET" | "WORKER_SECRET";

export function getSecret(name: SecretName) {
  required([name]);
  return process.env[name]!;
}

export function getConfigurationStatus() {
  const hasAll = (names: string[]) =>
    names.every((name) => Boolean(process.env[name]?.trim()));

  return {
    supabase: hasAll([
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]),
    ai: hasAll([
      "AI_RELAY_BASE_URL",
      "AI_RELAY_API_KEY",
      "AI_TEXT_MODEL",
      "AI_IMAGE_MODEL",
    ]),
    feishu: hasAll([
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "FEISHU_BITABLE_APP_TOKEN",
      "FEISHU_TABLE_ID",
    ]),
    security: hasAll(["CRON_SECRET", "WORKER_SECRET"]),
  };
}
