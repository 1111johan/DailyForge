import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import {
  getPromptSettings,
  savePromptSettings,
} from "@/lib/settings/prompt-settings";
import { PromptSettingsSchema } from "@/lib/settings/prompt-settings-schema";
import { WorkflowError } from "@/lib/workflow/errors";
import { assertAdminRequest } from "@/lib/security/admin-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertAdminRequest(request);
    return NextResponse.json({ ok: true, data: await getPromptSettings() });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertAdminRequest(request);
    const parsed = PromptSettingsSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError(
        parsed.error.issues.map((issue) => issue.message).join("; "),
        "INVALID_PROMPT_SETTINGS",
        false,
      );
    }
    return NextResponse.json({ ok: true, data: await savePromptSettings(parsed.data) });
  } catch (error) {
    return routeError(error);
  }
}
