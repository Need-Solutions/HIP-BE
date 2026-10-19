import { z } from "zod";

export const staffLoginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter an email address")
    .email("Enter a valid email address, e.g. name@example.com")
    .toLowerCase(),
  password: z.string().min(1, "Enter your password").max(1024),
});
export const staffCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export const staffChallengeSchema = z.object({
  challengeId: z.string().min(1).max(100),
});
export const staffVerifySchema = staffChallengeSchema.merge(staffCodeSchema);
