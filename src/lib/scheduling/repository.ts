import { getFeishuConfig } from "@/lib/config/env";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import {
  createFeishuRecord,
  deleteFeishuRecord,
  getFeishuRecord,
  listFeishuRecords,
  updateFeishuRecord,
} from "@/lib/feishu/bitable";
import {
  booleanValue,
  dateField,
  dateValue,
  jsonValue,
  numberValue,
  textValue,
} from "@/lib/feishu/values";
import type { GenerationSchedule } from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";
import type { ScheduleInput, SchedulePatch } from "@/lib/scheduling/schedule-schema";

const TIMEZONE = "Asia/Shanghai";

function partsAt(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function nextScheduleAt(
  runTime: string,
  weekdays: number[],
  after = new Date(),
) {
  const [hour, minute] = runTime.split(":").map(Number);
  const local = partsAt(after);
  const localYear = Number(local.year);
  const localMonth = Number(local.month);
  const localDay = Number(local.day);
  const base = new Date(`${local.year}-${local.month}-${local.day}T00:00:00+08:00`);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(base.getTime() + offset * 86_400_000);
    const localCalendarDate = new Date(
      Date.UTC(localYear, localMonth - 1, localDay + offset),
    );
    const isoDay =
      localCalendarDate.getUTCDay() === 0 ? 7 : localCalendarDate.getUTCDay();
    if (!weekdays.includes(isoDay)) continue;
    const at = new Date(candidate.getTime() + hour * 3_600_000 + minute * 60_000);
    if (at.getTime() > after.getTime()) return at.toISOString();
  }
  throw new WorkflowError("Unable to calculate next schedule", "SCHEDULE_TIME_INVALID", false);
}

function scheduleFromRecord(record: Awaited<ReturnType<typeof getFeishuRecord>>): GenerationSchedule {
  const fields = record.fields;
  return {
    id: record.record_id,
    name: textValue(fields["\u8ba1\u5212\u540d\u79f0"], "\u672a\u547d\u540d\u8ba1\u5212"),
    run_time: textValue(fields["\u8fd0\u884c\u65f6\u95f4"], "08:00"),
    weekdays: jsonValue<number[]>(fields["\u6267\u884c\u661f\u671f"], [1, 2, 3, 4, 5, 6, 7]),
    post_count: numberValue(fields["\u751f\u6210\u6761\u6570"], 3),
    product_mode: textValue(fields["\u4ea7\u54c1\u6a21\u5f0f"], "rotate") as GenerationSchedule["product_mode"],
    is_enabled: booleanValue(fields["\u662f\u5426\u542f\u7528"], true),
    next_run_at: dateValue(fields["\u4e0b\u6b21\u8fd0\u884c"]),
    last_run_at: dateValue(fields["\u4e0a\u6b21\u8fd0\u884c"]),
    created_at: record.created_time
      ? new Date(
          Number(record.created_time) < 10_000_000_000
            ? Number(record.created_time) * 1000
            : Number(record.created_time),
        ).toISOString()
      : new Date().toISOString(),
    updated_at: record.last_modified_time
      ? new Date(
          Number(record.last_modified_time) < 10_000_000_000
            ? Number(record.last_modified_time) * 1000
            : Number(record.last_modified_time),
        ).toISOString()
      : new Date().toISOString(),
  };
}

function scheduleFields(input: ScheduleInput | SchedulePatch, current?: GenerationSchedule) {
  const merged = {
    name: input.name ?? current?.name,
    runTime: input.runTime ?? current?.run_time,
    weekdays: input.weekdays ?? current?.weekdays,
    postCount: input.postCount ?? current?.post_count,
    productMode: input.productMode ?? current?.product_mode,
    isEnabled: input.isEnabled ?? current?.is_enabled,
  };
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields["\u8ba1\u5212\u540d\u79f0"] = input.name;
  if (input.runTime !== undefined) fields["\u8fd0\u884c\u65f6\u95f4"] = input.runTime;
  if (input.weekdays !== undefined) fields["\u6267\u884c\u661f\u671f"] = JSON.stringify(input.weekdays);
  if (input.postCount !== undefined) fields["\u751f\u6210\u6761\u6570"] = input.postCount;
  if (input.productMode !== undefined) fields["\u4ea7\u54c1\u6a21\u5f0f"] = input.productMode;
  if (input.isEnabled !== undefined) fields["\u662f\u5426\u542f\u7528"] = input.isEnabled;
  if (merged.runTime && merged.weekdays && merged.isEnabled !== undefined) {
    fields["\u4e0b\u6b21\u8fd0\u884c"] = merged.isEnabled
      ? dateField(nextScheduleAt(merged.runTime, merged.weekdays))
      : null;
  }
  return fields;
}

export async function listGenerationSchedules() {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const records = await listFeishuRecords(token, config.scheduleTableId);
  return records.map(scheduleFromRecord).toSorted((left, right) =>
    (left.next_run_at || "z").localeCompare(right.next_run_at || "z"),
  );
}

export async function createGenerationSchedule(input: ScheduleInput) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const record = await createFeishuRecord(
    token,
    config.scheduleTableId,
    scheduleFields(input),
  );
  return scheduleFromRecord(record);
}

export async function updateGenerationSchedule(id: string, input: SchedulePatch) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const current = scheduleFromRecord(await getFeishuRecord(token, config.scheduleTableId, id));
  await updateFeishuRecord(
    token,
    config.scheduleTableId,
    id,
    scheduleFields(input, current),
  );
  return scheduleFromRecord(await getFeishuRecord(token, config.scheduleTableId, id));
}

export async function deleteGenerationSchedule(id: string) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  await deleteFeishuRecord(token, config.scheduleTableId, id);
}

export async function markScheduleRun(schedule: GenerationSchedule, scheduledFor: string) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const next = nextScheduleAt(schedule.run_time, schedule.weekdays, new Date(scheduledFor));
  await updateFeishuRecord(token, config.scheduleTableId, schedule.id, {
    "\u4e0a\u6b21\u8fd0\u884c": dateField(scheduledFor),
    "\u4e0b\u6b21\u8fd0\u884c": dateField(next),
  });
}
