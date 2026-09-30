import { NextResponse } from "next/server";
import { authenticateOperatorDevice } from "@/lib/devices/repository";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import { routeError } from "@/lib/http/route-error";
import { deviceCanDownloadMedia } from "@/lib/social/repository";
import { WorkflowError } from "@/lib/workflow/errors";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordId: string; token: string }> },
) {
  try {
    const device = await authenticateOperatorDevice(request);
    const { recordId, token: fileToken } = await context.params;
    if (
      !/^rec[A-Za-z0-9]+$/.test(recordId) ||
      !fileToken ||
      fileToken.length > 200 ||
      !(await deviceCanDownloadMedia(device, recordId, fileToken))
    ) {
      throw new WorkflowError("图片不存在", "SOCIAL_MEDIA_NOT_FOUND", false);
    }
    const tenantToken = await getFeishuTenantToken();
    const response = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      { headers: { Authorization: `Bearer ${tenantToken}` } },
    );
    if (!response.ok || !response.body) {
      throw new WorkflowError(
        `飞书图片下载失败：${response.status}`,
        `FEISHU_MEDIA_HTTP_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    return new NextResponse(response.body, {
      headers: {
        "Content-Type": response.headers.get("content-type") || "image/png",
        "Cache-Control": "private, no-store",
        "Content-Disposition": "attachment",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
