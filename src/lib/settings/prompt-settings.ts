import { getFeishuConfig } from "@/lib/config/env";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import {
  createFeishuRecord,
  findFeishuRecordByField,
  updateFeishuRecord,
} from "@/lib/feishu/bitable";
import {
  DEFAULT_PROMPT_SETTINGS,
  PROMPT_SETTINGS_KEY,
  PromptSettingsSchema,
  type PromptSettings,
} from "@/lib/settings/prompt-settings-schema";

export async function getPromptSettings(): Promise<PromptSettings> {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const record = await findFeishuRecordByField(
    token,
    config.settingsTableId,
    "\u8bbe\u7f6e\u952e",
    PROMPT_SETTINGS_KEY,
  );
  if (!record) return { ...DEFAULT_PROMPT_SETTINGS };
  const parsed = PromptSettingsSchema.safeParse({
    copyPrompt: record.fields["\u6587\u6848\u63d0\u793a\u8bcd"],
    imagePrompt: record.fields["\u56fe\u7247\u63d0\u793a\u8bcd"],
  });
  return parsed.success ? parsed.data : { ...DEFAULT_PROMPT_SETTINGS };
}

export async function savePromptSettings(input: PromptSettings): Promise<PromptSettings> {
  const settings = PromptSettingsSchema.parse(input);
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const existing = await findFeishuRecordByField(
    token,
    config.settingsTableId,
    "\u8bbe\u7f6e\u952e",
    PROMPT_SETTINGS_KEY,
  );
  const fields = {
    "\u8bbe\u7f6e\u952e": PROMPT_SETTINGS_KEY,
    "\u6587\u6848\u63d0\u793a\u8bcd": settings.copyPrompt,
    "\u56fe\u7247\u63d0\u793a\u8bcd": settings.imagePrompt,
  };
  if (existing) {
    await updateFeishuRecord(token, config.settingsTableId, existing.record_id, fields);
  } else {
    await createFeishuRecord(token, config.settingsTableId, fields);
  }
  return settings;
}
