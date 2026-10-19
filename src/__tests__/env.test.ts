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
