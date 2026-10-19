import dotenv from "dotenv";
import isEmail from "validator/lib/isEmail";
import { z } from "zod";

dotenv.config();

const portSchema = z.coerce.number().int().min(1).max(65535);
const optionalSetting = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: portSchema.default(5001),
    MONGODB_URI: z
      .string()
      .regex(/^mongodb(?:\+srv)?:\/\//, "Use a MongoDB connection URL."),
    CLIENT_URL: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) && url.origin === value
          );
        } catch {
          return false;
        }
      }, "CLIENT_URL must be an HTTP origin without a trailing slash or path."),
    JWT_SECRET: z
      .string()
      .min(32, "JWT_SECRET must contain at least 32 characters."),
    SMTP_HOST: z.string().trim().min(1),
    ENCRYPTION_KEY: z
      .string()
      .regex(
        /^[a-fA-F0-9]{64}$/,
        "ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters.",
      ),
    SUPER_ADMIN_EMAIL: optionalSetting(z.string().trim().email().toLowerCase()),
    SUPER_ADMIN_NAME: optionalSetting(z.string().trim().min(2).max(80)),
    SUPER_ADMIN_PASSWORD: optionalSetting(
      z
        .string()
        .min(8)
        .regex(/\d/, "Add at least one number.")
        .regex(/[^A-Za-z0-9]/, "Add at least one symbol.")
        .refine(
          (value) => Buffer.byteLength(value, "utf8") <= 72,
          "Keep the password within 72 bytes.",
        ),
    ),
    SMTP_PORT: portSchema,
    SMTP_USER: z.string().default(""),
    SMTP_PASS: z.string().default(""),
    MAIL_FROM: z
      .string()
      .trim()
      .refine(
        (value) =>
          (!value.includes("<") || value.endsWith(">")) &&
          isEmail(value, { allow_display_name: true }),
        {
          message:
            'Use an email address or a named sender such as "HIP <hip@example.com>".',
        },
      ),
    DEV_FIXED_CODE: z
      .string()
      .regex(/^\d{6}$/, "DEV_FIXED_CODE must be six digits.")
      .optional(),
  })
  .superRefine((env, ctx) => {
    const seedFields = [
      env.SUPER_ADMIN_EMAIL,
      env.SUPER_ADMIN_NAME,
      env.SUPER_ADMIN_PASSWORD,
    ];
    if (seedFields.some(Boolean) && !seedFields.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPER_ADMIN_EMAIL"],
        message:
          "Set SUPER_ADMIN_EMAIL, SUPER_ADMIN_NAME and SUPER_ADMIN_PASSWORD together.",
      });
    }
    if (env.NODE_ENV === "production" && env.DEV_FIXED_CODE !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEV_FIXED_CODE"],
        message: "DEV_FIXED_CODE is forbidden in production.",
      });
    }
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SMTP_USER"],
        message:
          "Set both SMTP_USER and SMTP_PASS, or leave both empty for a local SMTP server.",
      });
    }
  });

const result = envSchema.safeParse(process.env);
if (!result.success) {
  // Never print environment values, including Zod's received values.
  throw new Error(
    `Invalid environment configuration: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
  );
}

export const ENV = result.data;
