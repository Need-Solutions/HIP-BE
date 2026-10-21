import { defineConfig } from "vitest/config";
import { randomBytes } from "node:crypto";

export default defineConfig({
  test: {
    watch: false,
    // These integration files clear collections in the same dedicated database.
    fileParallelism: false,
    // Integration tests exercise production-cost bcrypt on the local machine.
    testTimeout: 20000,
    hookTimeout: 20000,
    root: ".",
    reporters: ["default"],
    setupFiles: ["./src/__tests__/setup.ts"],
    env: {
      MONGODB_URI:
        process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/hip_auth_test",
      NODE_ENV: "test",
      CLIENT_URL: "http://localhost:5173",
      JWT_SECRET: randomBytes(48).toString("hex"),
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      SUPER_ADMIN_EMAIL: "",
      SUPER_ADMIN_NAME: "",
      SUPER_ADMIN_PASSWORD: "",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
      SMTP_USER: "",
      SMTP_PASS: "",
      MAIL_FROM: "hip@example.com",
      // Synthetic per-run value: tests must never call Paystack with a developer's actual key.
      PAYSTACK_SECRET_KEY: `sk_test_${randomBytes(24).toString("hex")}`,
    },
  },
});
