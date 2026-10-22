import { z } from "zod";
export const ticketCodeSchema = z
  .object({
    code: z
      .string()
      .toUpperCase()
      .regex(/^HIP-[A-Z0-9]{4}-[A-Z0-9]{4}$/, "Enter a valid ticket code"),
  })
  .strict();
export const accountTicketsQuery = z
  .object({
    tab: z.enum(["upcoming", "past", "cancelled"]).optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AccountTicketsQuery = z.infer<typeof accountTicketsQuery>;
export const refundRequestSchema = z
  .object({
    reason: z.string().trim().min(3, "Tell us why you need a refund").max(500),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export const historyQuerySchema = z
  .object({ includeTotals: z.enum(["true", "false"]).optional() })
  .strict();
export const deleteAccountSchema = z
  .object({
    password: z.string().min(1, "Enter your password").max(200),
    confirm: z.literal("DELETE", {
      errorMap: () => ({ message: "Type DELETE to confirm account deletion" }),
    }),
  })
  .strict();
