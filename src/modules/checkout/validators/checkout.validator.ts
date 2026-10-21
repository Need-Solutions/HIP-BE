import { z } from "zod";
import { normalisePhone } from "../../users/validators/auth.validator";

export const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "Invalid ID.")
  .toLowerCase();
const name = z
  .string()
  .trim()
  .min(2, "Enter a full name")
  .max(80, "Keep the name under 80 characters");
const email = z
  .string()
  .trim()
  .email("Enter a valid email address, e.g. name@example.com")
  .max(254)
  .toLowerCase();
const phone = z
  .string()
  .trim()
  .transform(normalisePhone)
  .refine(
    (value) =>
      /^(?:\+?234|0)[789][01]\d{8}$/.test(value) ||
      /^\+[1-9]\d{7,14}$/.test(value),
    "Enter a valid phone number, e.g. +234 803 000 0000",
  );
const items = z
  .array(
    z
      .object({
        ticketTypeId: objectId,
        quantity: z
          .number()
          .int()
          .min(1)
          .max(10, "You can buy up to 10 tickets in one order."),
      })
      .strict(),
  )
  .min(1)
  .max(10)
  .superRefine((values, ctx) => {
    if (values.reduce((sum, item) => sum + item.quantity, 0) > 10)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "You can buy up to 10 tickets in one order.",
      });
    if (new Set(values.map((item) => item.ticketTypeId)).size !== values.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A ticket type cannot appear twice.",
      });
  });
export const holdSchema = z.object({ eventId: objectId, items }).strict();
export const checkoutSchema = holdSchema
  .extend({
    holdId: objectId,
    buyer: z.object({ fullName: name, email, phone }).strict(),
    attendees: z
      .array(
        z
          .object({
            ticketTypeId: objectId,
            fullName: name,
            email: email.optional(),
            phone: phone.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    emergencyContact: z.object({ name, phone }).strict(),
    createAccount: z.boolean().default(false),
    whatsappReminders: z.boolean().default(false),
    paymentChannel: z.enum(["card", "bank_transfer", "ussd"]),
  })
  .superRefine((value, ctx) => {
    const expected = value.items.flatMap((item) =>
      Array<string>(item.quantity).fill(item.ticketTypeId),
    );
    if (
      expected.length !== value.attendees.length ||
      value.attendees.some(
        (attendee, i) => attendee.ticketTypeId !== expected[i],
      )
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attendees"],
        message: "Each ticket needs an attendee name.",
      });
    if (value.emergencyContact.phone === value.buyer.phone)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emergencyContact", "phone"],
        message: "Use a different phone number from your own.",
      });
  });
export const checkoutIdSchema = z.object({ id: objectId });
export type HoldRequest = z.infer<typeof holdSchema>;
export type CheckoutRequest = z.infer<typeof checkoutSchema>;
