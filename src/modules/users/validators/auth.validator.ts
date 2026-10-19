import { z } from "zod";

// Keep these messages aligned with frontend src/lib/validation.ts (NFR-024).
export const normalisePhone = (value: string) => value.replace(/[\s()-]/g, "");
const isPhone = (value: string) =>
  /^(?:\+?234|0)[789][01]\d{8}$/.test(value) || /^\+[1-9]\d{7,14}$/.test(value);
const email = z
  .string()
  .trim()
  .min(1, "Enter an email address")
  .email("Enter a valid email address, e.g. name@example.com")
  .toLowerCase();
const password = z
  .string()
  .min(8, "Use at least 8 characters")
  .regex(/\d/, "Add at least one number")
  .regex(/[^A-Za-z0-9]/, "Add at least one symbol, e.g. ! or #")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Keep the password within 72 bytes",
  );
const verificationId = z.string().min(1).max(100);

export const signupSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Enter a full name")
    .max(80, "Keep the name under 80 characters"),
  email,
  phone: z
    .string()
    .trim()
    .min(1, "Enter a phone number")
    .transform(normalisePhone)
    .refine(isPhone, "Enter a valid phone number, e.g. +234 803 000 0000"),
  password,
});
export const verifySchema = z.object({
  verificationId,
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export const resendSchema = z.object({
  verificationId,
  channel: z.enum(["email", "phone"]),
});
export const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, "Enter your email or phone number")
    .max(254),
  password: z.string().min(1, "Enter your password").max(1024),
  remember: z.boolean().default(false),
});
export const forgotSchema = z.object({ email });
export const resetSchema = z.object({ token: z.string().max(256), password });
export const emptySchema = z.object({}).default({});

export type SignupRequest = z.infer<typeof signupSchema>;
