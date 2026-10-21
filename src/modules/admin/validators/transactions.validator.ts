import { z } from "zod";
import { calendarDate } from "../../events/validators/event.validator";
export const transactionsQuerySchema = z
  .object({
    from: calendarDate,
    to: calendarDate,
    prevFrom: calendarDate.optional(),
    prevTo: calendarDate.optional(),
    status: z
      .enum([
        "all",
        "successful",
        "pending",
        "failed",
        "refund_requested",
        "refunded",
      ])
      .default("all"),
    q: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    all: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    path: ["to"],
    message: "End date must be on or after start date",
  })
  .refine(
    (v) =>
      Boolean(v.prevFrom) === Boolean(v.prevTo) &&
      (!v.prevFrom || v.prevFrom <= v.prevTo!),
    { path: ["prevTo"], message: "Provide a valid previous date range" },
  );
export const ticketCodeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9-]+$/)
      .transform((v) => v.toUpperCase()),
  })
  .strict();
export type TransactionsQuery = z.infer<typeof transactionsQuerySchema>;
