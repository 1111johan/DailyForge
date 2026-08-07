import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import {
  getPromptSettings,
  savePromptSettings,
} from "@/lib/settings/prompt-settings";
import { PromptSettingsSchema } from "@/lib/settings/prompt-settings-schema";
import { WorkflowError } from "@/lib/workflow/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, data: await getPromptSettings() });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: Request) {
  try {
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
