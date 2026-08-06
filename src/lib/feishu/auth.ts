import { getFeishuConfig } from "@/lib/config/env";
import { feishuFetch } from "@/lib/feishu/client";
import { WorkflowError } from "@/lib/workflow/errors";

export async function getFeishuTenantToken() {
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
  return result.tenant_access_token;
}
