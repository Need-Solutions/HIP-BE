import { z } from "zod";
import { normalisePhone, signupSchema } from "./auth.validator";

const dateOfBirth = z
  .string()
  .refine((value) => {
    if (!value) return true;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= "1900-01-01" &&
      value <= today
    );
  }, "Enter a real date of birth, not in the future")
  .transform((value) => value || undefined)
  .optional();

export const profileUpdateSchema = signupSchema
  .pick({ fullName: true, email: true, phone: true })
  .extend({
    dateOfBirth,
    emergencyContact: z
      .object({
        name: z
          .string()
          .trim()
          .min(1, "Add their name too")
          .max(80, "Keep the name under 80 characters"),
        phone: signupSchema.shape.phone,
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.emergencyContact &&
      normalisePhone(value.emergencyContact.phone) === value.phone
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emergencyContact", "phone"],
        message: "Use someone else’s number, not your own",
      });
    }
  });

export const contactIdSchema = z.object({
  verificationId: z.string().min(1).max(100),
});

export const notificationSchema = z.object({
  reminders: z.boolean(),
  reminderChannel: z.enum(["email_whatsapp", "email", "whatsapp"]),
  promotions: z.boolean(),
});

export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
export type NotificationUpdate = z.infer<typeof notificationSchema>;
