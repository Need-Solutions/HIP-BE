import { z } from "zod";

export const checkoutSettingsSchema = z
  .object({
    platformFeePercent: z
      .number()
      .gt(0, "Enter a percentage above zero")
      .max(100)
      .refine(
        (value) => Number.isInteger(Number((value * 100).toFixed(8))),
        "Use at most two decimal places",
      ),
    platformFeeMode: z.enum(["added_to_buyer", "deducted_from_group"]),
    platformFeeOnRefund: z.enum(["refund", "keep"]),
    paystackFeeBearer: z.enum(["hiker", "group"]),
  })
  .strict()
  .refine(
    (value) =>
      !(
        value.platformFeePercent === 100 &&
        value.platformFeeMode === "deducted_from_group" &&
        value.paystackFeeBearer === "group"
      ),
    {
      path: ["platformFeePercent"],
      message: "Leave enough group proceeds to cover Paystack's fee",
    },
  );

export const settlementAccountSchema = z
  .object({
    bankCode: z
      .string()
      .trim()
      .regex(/^\d{3,6}$/, "Enter the Paystack bank code"),
    accountNumber: z
      .string()
      .regex(/^\d{10}$/, "Enter a 10-digit account number"),
    accountName: z.string().trim().min(2).max(160),
    // Explicit opt-in for provider-backed test-card payments; live keys always use Paystack.
    registerWithPaystack: z.boolean().optional(),
  })
  .strict();
