import { describe, expect, it } from "vitest";
import { ENV, envSchema } from "../config/env";

describe("MAIL_FROM validation", () => {
  it.each([
    "hip@example.com",
    "HIP <hip@example.com>",
    '"Hikers Integrated Platform" <hip@example.com>',
    "  HIP <hip@example.com>  ",
  ])("accepts a sender address: %s", (MAIL_FROM) => {
    const result = envSchema.safeParse({ ...ENV, MAIL_FROM });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.MAIL_FROM).toBe(MAIL_FROM.trim());
    }
  });

  it.each([
    "",
    "not-an-email",
    "HIP <not-an-email>",
    "HIP <hip@example.com",
    "HIP <one@example.com>, Other <two@example.com>",
    "HIP\r\nBcc: other@example.com <hip@example.com>",
  ])("rejects an invalid sender: %s", (MAIL_FROM) => {
    expect(envSchema.safeParse({ ...ENV, MAIL_FROM }).success).toBe(false);
  });
});

describe("Cloudinary settings", () => {
  const empty = {
    CLOUDINARY_CLOUD_NAME: "",
    CLOUDINARY_API_KEY: "",
    CLOUDINARY_API_SECRET: "",
  };
  it("allows disabled uploads and validates complete settings without exposing values", () => {
    expect(envSchema.safeParse({ ...ENV, ...empty }).success).toBe(true);
    expect(
      envSchema.safeParse({
        ...ENV,
        ...empty,
        CLOUDINARY_CLOUD_NAME: "test-cloud",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...ENV,
        CLOUDINARY_CLOUD_NAME: "test-cloud",
        CLOUDINARY_API_KEY: "1234",
        CLOUDINARY_API_SECRET: "test-only",
      }).success,
    ).toBe(true);
    expect(
      envSchema.safeParse({
        ...ENV,
        CLOUDINARY_CLOUD_NAME: "https://invalid.example.com",
      }).success,
    ).toBe(false);
  });
});
