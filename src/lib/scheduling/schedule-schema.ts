import { z } from "zod";

const RunTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "请选择有效时间");

const WeekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .min(1, "至少选择一天")
  .max(7)
  .refine((days) => new Set(days).size === days.length, "星期不能重复")
  .transform((days) => days.toSorted((a, b) => a - b));

export const ProductModeSchema = z.enum(["rotate", "cet4", "cet6"]);

export const ScheduleInputSchema = z.object({
  name: z.string().trim().min(1, "计划名称不能为空").max(80),
  runTime: RunTimeSchema,
  weekdays: WeekdaysSchema,
  postCount: z.number().int().min(1).max(20),
  productMode: ProductModeSchema,
  isEnabled: z.boolean(),
});

export const SchedulePatchSchema = ScheduleInputSchema.partial().refine(
  (input) => Object.keys(input).length > 0,
  "没有需要保存的修改",
);

export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
export type SchedulePatch = z.infer<typeof SchedulePatchSchema>;
