import { httpError, WorkflowError } from "@/lib/workflow/errors";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

interface FeishuEnvelope {
  code?: number;
  msg?: string;
  data?: unknown;
  tenant_access_token?: string;
}

export async function feishuFetch(
  path: string,
  init: RequestInit,
  token?: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) throw httpError("FEISHU", response.status, text);

    let result: FeishuEnvelope;
    try {
      result = JSON.parse(text) as FeishuEnvelope;
    } catch (error) {
      throw new WorkflowError(
        "Feishu returned invalid JSON",
        "FEISHU_INVALID_JSON",
        false,
        { cause: error },
      );
    }
    if (result.code !== undefined && result.code !== 0) {
      const retryableCodes = new Set([99991400, 99991663, 99991664]);
      throw new WorkflowError(
        `Feishu error ${result.code}: ${result.msg || "Unknown error"}`,
        `FEISHU_API_${result.code}`,
        retryableCodes.has(result.code),
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
