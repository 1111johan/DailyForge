import { NextResponse } from "next/server";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import { routeError } from "@/lib/http/route-error";
import { WorkflowError } from "@/lib/workflow/errors";

type MediaRouteContext = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: MediaRouteContext) {
  try {
    const { token: fileToken } = await context.params;
    if (!fileToken || fileToken.length > 200) {
      throw new WorkflowError("Invalid file token", "INVALID_FILE_TOKEN", false);
    }
    const tenantToken = await getFeishuTenantToken();
    const response = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      { headers: { Authorization: `Bearer ${tenantToken}` } },
    );
    if (!response.ok || !response.body) {
      throw new WorkflowError(
        `Feishu media download failed: ${response.status}`,
        `FEISHU_MEDIA_HTTP_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    return new NextResponse(response.body, {
      headers: {
        "Content-Type": response.headers.get("content-type") || "image/png",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
