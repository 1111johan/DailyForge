import { getFeishuConfig } from "@/lib/config/env";
import { feishuFetch } from "@/lib/feishu/client";
import { WorkflowError } from "@/lib/workflow/errors";

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getFeishuTenantToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  const config = getFeishuConfig();
  const result = await feishuFetch(
    "/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    },
  );
  if (!result.tenant_access_token) {
    throw new WorkflowError(
      "Feishu token response is empty",
      "FEISHU_TOKEN_EMPTY",
      false,
    );
  }
  cachedToken = {
    value: result.tenant_access_token,
    expiresAt: Date.now() + 90 * 60_000,
  };
  return cachedToken.value;
}
