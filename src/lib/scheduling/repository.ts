import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type {
  GenerationBatch,
  GenerationSchedule,
} from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";
import type {
  ScheduleInput,
  SchedulePatch,
} from "@/lib/scheduling/schedule-schema";

function schedulingError(
  message: string,
  error: { message: string; code?: string },
) {
  return new WorkflowError(
    `${message}: ${error.message}`,
    `SCHEDULING_${error.code || "ERROR"}`,
    !error.code || !["23503", "23505", "23514", "PGRST116"].includes(error.code),
  );
}

function scheduleRow(input: ScheduleInput | SchedulePatch) {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.runTime === undefined ? {} : { run_time: input.runTime }),
    ...(input.weekdays === undefined ? {} : { weekdays: input.weekdays }),
    ...(input.postCount === undefined ? {} : { post_count: input.postCount }),
    ...(input.productMode === undefined
      ? {}
      : { product_mode: input.productMode }),
    ...(input.isEnabled === undefined
      ? {}
      : { is_enabled: input.isEnabled }),
  };
}

export async function listGenerationSchedules() {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("generation_schedules")
    .select("*")
    .order("next_run_at", { ascending: true, nullsFirst: false })
    .order("created_at");
  if (error) throw schedulingError("Failed to load schedules", error);
  return (data || []) as GenerationSchedule[];
}

export async function createGenerationSchedule(input: ScheduleInput) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("generation_schedules")
    .insert(scheduleRow(input))
    .select("*")
    .single();
  if (error) throw schedulingError("Failed to create schedule", error);
  return data as GenerationSchedule;
}

export async function updateGenerationSchedule(
  id: string,
  input: SchedulePatch,
) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("generation_schedules")
    .update(scheduleRow(input))
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw schedulingError("Failed to update schedule", error);
  return data as GenerationSchedule;
}

export async function deleteGenerationSchedule(id: string) {
  const supabase = createSupabaseAdmin();
  const { error, count } = await supabase
    .from("generation_schedules")
    .delete({ count: "exact" })
    .eq("id", id);
  if (error) throw schedulingError("Failed to delete schedule", error);
  if (!count) {
    throw new WorkflowError("Schedule does not exist", "SCHEDULE_NOT_FOUND", false);
  }
}

export async function createManualBatch(input: {
  idempotencyKey: string;
  requestedCount: number;
  productMode: GenerationBatch["product_mode"];
  productId?: string;
  promptSnapshot: Record<string, unknown>;
}) {
  const supabase = createSupabaseAdmin();
  const row = {
    source: "manual",
    schedule_id: null,
    product_id: input.productId || null,
    scheduled_for: null,
    idempotency_key: input.idempotencyKey,
    requested_count: input.requestedCount,
    product_mode: input.productMode,
    prompt_snapshot: input.promptSnapshot,
  };
  const { data, error } = await supabase
    .from("generation_batches")
    .upsert(row, { onConflict: "idempotency_key", ignoreDuplicates: true })
    .select("*")
    .maybeSingle();
  if (error) throw schedulingError("Failed to create generation batch", error);
  if (data) return data as GenerationBatch;

  const { data: existing, error: existingError } = await supabase
    .from("generation_batches")
    .select("*")
    .eq("idempotency_key", input.idempotencyKey)
    .single();
  if (existingError) {
    throw schedulingError("Failed to load generation batch", existingError);
  }
  return existing as GenerationBatch;
}

export async function listPendingGenerationBatches() {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("generation_batches")
    .select("*")
    .eq("status", "pending")
    .order("created_at")
    .limit(20);
  if (error) throw schedulingError("Failed to load pending batches", error);
  return (data || []) as GenerationBatch[];
}

export async function claimDueGenerationBatches() {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase.rpc("claim_due_generation_batches", {
    p_limit: 10,
  });
  if (error) throw schedulingError("Failed to claim due schedules", error);
  return (data || []) as GenerationBatch[];
}

export async function updateGenerationBatch(
  id: string,
  update: Partial<
    Pick<
      GenerationBatch,
      "created_count" | "status" | "attempts" | "error_message"
    >
  >,
) {
  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("generation_batches")
    .update(update)
    .eq("id", id);
  if (error) throw schedulingError("Failed to update generation batch", error);
}
