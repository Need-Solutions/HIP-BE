import { z } from "zod";
import { AdminRole } from "../../../database/models/admin.schema";
import { resetSchema } from "../../users/validators/auth.validator";

export const staffParamsSchema = z.object({
  id: z
    .string()
    .regex(/^(?:[a-f\d]{24}|inv_[a-f\d-]{36})$/i, "Invalid staff or invite ID")
    .toLowerCase(),
});
export const roleSchema = z.object({ role: z.nativeEnum(AdminRole) });
export const inviteSchema = roleSchema.extend({
  name: z
    .string()
    .trim()
    .min(2, "Enter a full name")
    .max(80, "Keep the name under 80 characters"),
  email: z
    .string()
    .trim()
    .min(1, "Enter an email address")
    .email("Enter a valid email address, e.g. name@example.com")
    .toLowerCase(),
});
export const acceptInviteSchema = z.object({
  token: z.string().max(256),
  password: resetSchema.shape.password,
});
