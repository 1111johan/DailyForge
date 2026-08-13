import type { FeishuAttachment } from "@/lib/feishu/bitable";

export function textValue(value: unknown, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          const segment = (item as { text?: unknown }).text;
          return typeof segment === "string" ? segment : "";
        }
        return "";
      })
      .join("");
    return text || fallback;
  }
  return fallback;
}

export function numberValue(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function booleanValue(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1) return true;
  if (value === "false" || value === 0) return false;
  return fallback;
}

export function dateValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function dateField(value: string | null | undefined) {
  return value ? new Date(value).getTime() : null;
}

export function jsonValue<T>(value: unknown, fallback: T): T {
  const text = textValue(value);
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function attachmentValues(value: unknown): FeishuAttachment[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is FeishuAttachment =>
          Boolean(item) && typeof item === "object",
      )
    : [];
}
