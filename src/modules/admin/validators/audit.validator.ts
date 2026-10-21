import { z } from "zod";
import { calendarDate } from "../../events/validators/event.validator";

export const AUDIT_GROUPS = [
  "events",
  "payments",
  "attendance",
  "refunds",
  "hikers",
  "staff",
  "ads",
  "settings",
] as const;
const optionalText = (max: number) => z.string().trim().max(max).optional();
export const auditQuerySchema = z
  .object({
    q: optionalText(200),
    action: optionalText(100).refine(
      (value) =>
        !value ||
        (value.startsWith("group:")
          ? (AUDIT_GROUPS as readonly string[]).includes(value.slice(6))
          : /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(value)),
      "Choose a valid action or action group",
    ),
    actorId: optionalText(200),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    all: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ["to"],
    message: "End date must be on or after start date",
  });
export type AuditQuery = z.infer<typeof auditQuerySchema>;
