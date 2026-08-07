import { createSupabaseAdmin } from "@/lib/supabase/admin";
import {
  DEFAULT_PROMPT_SETTINGS,
  PROMPT_SETTINGS_KEY,
  PromptSettingsSchema,
  type PromptSettings,
} from "@/lib/settings/prompt-settings-schema";
import { WorkflowError } from "@/lib/workflow/errors";

interface AppSettingRow {
  key: string;
  value: unknown;
  updated_at: string;
}

export async function getPromptSettings(): Promise<PromptSettings> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_settings")
    .select("key,value,updated_at")
    .eq("key", PROMPT_SETTINGS_KEY)
    .maybeSingle();

  if (error) {
    throw new WorkflowError(
      `Failed to load prompt settings: ${error.message}`,
      "PROMPT_SETTINGS_QUERY_FAILED",
      true,
      { cause: error },
    );
  }

  const parsed = PromptSettingsSchema.safeParse((data as AppSettingRow | null)?.value);
  return parsed.success ? parsed.data : { ...DEFAULT_PROMPT_SETTINGS };
}

export async function savePromptSettings(input: PromptSettings): Promise<PromptSettings> {
  const settings = PromptSettingsSchema.parse(input);
  const supabase = createSupabaseAdmin();
  const { error } = await supabase.from("app_settings").upsert(
    {
      key: PROMPT_SETTINGS_KEY,
      value: settings,
    },
    { onConflict: "key" },
  );

  if (error) {
    throw new WorkflowError(
      `Failed to save prompt settings: ${error.message}`,
      "PROMPT_SETTINGS_SAVE_FAILED",
      true,
      { cause: error },
    );
  }
  return settings;
}
