import { randomBytes, randomInt } from "crypto";
import mongoose from "mongoose";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import jwt from "jsonwebtoken";
import { app } from "../app";
import bootstrap from "../bootstrap";
import { limiter } from "../bootstrap/rate-limiting";
import { ENV, envSchema } from "../config/env";
import { LoginAttemptModel } from "../database/models/login-attempt.schema";
import { PasswordResetModel } from "../database/models/password-reset.schema";
import { UserModel } from "../database/models/users.schema";
import { VerificationCodeModel } from "../database/models/verification-code.schema";
import { sendMail } from "../services/mail.service";

vi.mock("../services/mail.service", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
const mail = vi.mocked(sendMail);
const password = () => `${randomBytes(18).toString("base64url")}1!`;
const credentials = () => ({
  fullName: "Ada Okafor",
  email: `ada-${randomBytes(6).toString("hex")}@example.com`,
  phone: `+234803${randomInt(1000000, 10000000)}`,
  password: password(),
});
const latestCode = () =>
  mail.mock.calls.at(-1)?.[0].text.match(/\b\d{6}\b/)?.[0] ?? "";
const latestToken = () =>
  mail.mock.calls.at(-1)?.[0].text.match(/token=([a-f0-9]{64})/)?.[1] ?? "";
const sessionCookie = (res: request.Response) =>
  String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0];

const signup = async () => {
  const body = credentials();
  const response = await request(app).post("/api/auth/user-signup").send(body);
  expect(response.status).toBe(201);
  return {
    body,
    verificationId: response.body.verificationId as string,
    code: latestCode(),
    response,
  };
};
const activeUser = async () => {
  const started = await signup();
  const response = await request(app)
    .post("/api/auth/user-verify")
    .send({ verificationId: started.verificationId, code: started.code });
  expect(response.status).toBe(200);
  return {
    ...started,
    userId: response.body.user.id as string,
    cookie: sessionCookie(response),
    verified: response,
  };
};
const postLogin = (identifier: string, secret: string, remember = false) =>
  request(app)
    .post("/api/auth/user-login")
    .send({ identifier, password: secret, remember });

beforeAll(async () => {
  // Refuse to clear collections in an application database by mistake.
  const databaseName = new URL(ENV.MONGODB_URI).pathname.slice(1);
  if (!/^hip_auth_test(?:_[a-z0-9]+)?$/.test(databaseName)) {
    throw new Error(
      "Auth integration tests require a dedicated hip_auth_test database.",
    );
  }
  await bootstrap.handleDBConnect();
}, 20000);
afterAll(async () => {
  await mongoose.disconnect();
});
beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    VerificationCodeModel.deleteMany({}),
    PasswordResetModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
  ]);
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) {
    limiter.resetKey(key);
  }
  mail.mockReset().mockResolvedValue(undefined);
});

describe("Users auth contract (AUTH-001–AUTH-013)", () => {
  it("stores hashes and returns exactly VerificationStart, then a cookie and VerifyResult", async () => {
    const started = await activeUser();
    expect(Object.keys(started.response.body).sort()).toEqual([
      "channel",
      "destination",
      "guestTicketsToMerge",
      "resendAvailableAt",
      "verificationId",
    ]);
    expect(started.response.body.destination).toBe(`a•••••@example.com`);
    expect(started.response.body.guestTicketsToMerge).toBe(0);
    expect(Object.keys(started.verified.body).sort()).toEqual([
      "mergedTickets",
      "user",
    ]);
    expect(Object.keys(started.verified.body.user).sort()).toEqual([
      "createdAt",
      "email",
      "emailVerified",
      "fullName",
      "id",
      "phone",
      "phoneVerified",
      "roles",
      "status",
    ]);
    expect(started.verified.body.user).toMatchObject({
      status: "active",
      roles: ["hiker"],
      emailVerified: true,
      phoneVerified: false,
    });
    const stored = await UserModel.findById(started.userId).select(
      "+passwordHash",
    );
    expect(stored?.passwordHash.startsWith("$2")).toBe(true);
    expect(stored?.passwordHash === started.body.password).toBe(false);
    expect(started.verified.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(started.verified.headers["set-cookie"][0]).toContain("SameSite=Lax");
    expect(started.verified.headers["set-cookie"][0].includes("Secure")).toBe(
      false,
    );
    const replay = await request(app)
      .post("/api/auth/user-verify")
      .send({ verificationId: started.verificationId, code: started.code });
    expect(replay.status).toBe(410);
  });

  it("returns user or null from /me and revokes a copied cookie on logout", async () => {
    expect((await request(app).get("/api/auth/me")).body).toBeNull();
    const user = await activeUser();
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", user.cookie)).body
        .id,
    ).toBe(user.userId);
    const logout = await request(app)
      .post("/api/auth/user-logout")
      .set("Cookie", user.cookie)
      .send({});
    expect(logout.status).toBe(204);
    expect(logout.text).toBe("");
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", user.cookie)).body,
    ).toBeNull();
    expect(
      (await request(app).post("/api/auth/user-logout").send({})).status,
    ).toBe(204);
  });

  it("rejects duplicate verified contacts with the exact messages and fields", async () => {
    const user = await activeUser();
    const duplicateEmail = await request(app)
      .post("/api/auth/user-signup")
      .send({ ...credentials(), email: ` ${user.body.email.toUpperCase()} ` });
    expect(duplicateEmail.status).toBe(409);
    expect(duplicateEmail.body).toEqual({
      message: "An account with this email already exists.",
      success: false,
      status: 409,
      code: "email_taken",
      field: "email",
    });
    const duplicatePhone = await request(app)
      .post("/api/auth/user-signup")
      .send({ ...credentials(), phone: user.body.phone });
    expect(duplicatePhone.status).toBe(409);
    expect(duplicatePhone.body).toMatchObject({
      code: "phone_taken",
      field: "phone",
      message: "An account with this phone number already exists.",
    });
  });

  it("replaces an unfinished signup and invalidates its previous code", async () => {
    const old = await signup();
    const changed = { ...old.body, fullName: "Ada New", password: password() };
    const replaced = await request(app)
      .post("/api/auth/user-signup")
      .send(changed);
    expect(replaced.status).toBe(201);
    expect(await UserModel.countDocuments({ email: old.body.email })).toBe(1);
    expect(
      (
        await request(app)
          .post("/api/auth/user-verify")
          .send({ verificationId: old.verificationId, code: old.code })
      ).status,
    ).toBe(410);
    expect((await postLogin(old.body.email, old.body.password)).body.code).toBe(
      "invalid_credentials",
    );
    const unverified = await postLogin(changed.email, changed.password);
    expect(unverified.status).toBe(403);
    expect(unverified.body).toMatchObject({
      code: "unverified",
      message: "Please verify your email to finish setting up your account.",
      verificationId: replaced.body.verificationId,
    });
  });

  it("counts five wrong verification codes and refuses the correct code afterwards", async () => {
    const started = await signup();
    const wrong = started.code === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request(app)
        .post("/api/auth/user-verify")
        .send({ verificationId: started.verificationId, code: wrong });
      expect(res.status).toBe(attempt === 5 ? 410 : 400);
      if (attempt < 5) {
        expect(res.body).toMatchObject({
          code: "invalid_code",
          message: "That code isn’t right.",
          attemptsLeft: 5 - attempt,
        });
      } else {
        expect(res.body.message).toBe(
          "Too many wrong codes. Request a new one.",
        );
      }
    }
    expect(
      (
        await request(app)
          .post("/api/auth/user-verify")
          .send({ verificationId: started.verificationId, code: started.code })
      ).status,
    ).toBe(410);
  });

  it("rejects expired codes even before MongoDB TTL cleanup", async () => {
    const started = await signup();
    const stored = await VerificationCodeModel.findOne({
      verificationId: started.verificationId,
    }).select("+codeHash");
    expect(stored?.codeHash === started.code).toBe(false);
    expect((stored?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      9 * 60 * 1000,
    );
    await VerificationCodeModel.updateOne(
      { verificationId: started.verificationId },
      { $set: { expiresAt: new Date(0) } },
    );
    const result = await request(app)
      .post("/api/auth/user-verify")
      .send({ verificationId: started.verificationId, code: started.code });
    expect(result.status).toBe(410);
  });

  it("enforces resend cooldown and rotates the verification ID after the wait", async () => {
    const started = await signup();
    const tooSoon = await request(app)
      .post("/api/auth/user-verify/resend")
      .send({ verificationId: started.verificationId, channel: "email" });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.code).toBe("rate_limited");
    expect(tooSoon.body.retryAfterSeconds).toBeGreaterThan(0);
    await VerificationCodeModel.updateOne(
      { verificationId: started.verificationId },
      { $set: { resendAvailableAt: new Date(0) } },
    );
    const resent = await request(app)
      .post("/api/auth/user-verify/resend")
      .send({ verificationId: started.verificationId, channel: "email" });
    expect(resent.status).toBe(200);
    expect(resent.body.verificationId === started.verificationId).toBe(false);
    const newCode = latestCode();
    expect(
      (
        await request(app)
          .post("/api/auth/user-verify")
          .send({ verificationId: started.verificationId, code: started.code })
      ).status,
    ).toBe(410);
    expect(
      (
        await request(app)
          .post("/api/auth/user-verify")
          .send({ verificationId: resent.body.verificationId, code: newCode })
      ).status,
    ).toBe(200);
  });

  it("logs phone codes only in development, supports DEV_FIXED_CODE and verifies the phone flag", async () => {
    const originalEnv = ENV.NODE_ENV;
    const originalCode = ENV.DEV_FIXED_CODE;
    const consoleSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      ENV.NODE_ENV = "development";
      ENV.DEV_FIXED_CODE = "123456";
      const started = await signup();
      expect(started.code === ENV.DEV_FIXED_CODE).toBe(true);
      await VerificationCodeModel.updateOne(
        { verificationId: started.verificationId },
        { $set: { resendAvailableAt: new Date(0) } },
      );
      const resent = await request(app)
        .post("/api/auth/user-verify/resend")
        .send({ verificationId: started.verificationId, channel: "phone" });
      expect(resent.status).toBe(200);
      expect(consoleSpy.mock.calls.length).toBe(1);
      const verified = await request(app).post("/api/auth/user-verify").send({
        verificationId: resent.body.verificationId,
        code: ENV.DEV_FIXED_CODE,
      });
      expect(verified.body.user).toMatchObject({
        emailVerified: false,
        phoneVerified: true,
        status: "active",
      });
    } finally {
      ENV.NODE_ENV = originalEnv;
      ENV.DEV_FIXED_CODE = originalCode;
      consoleSpy.mockRestore();
    }
  });

  it("refuses phone delivery outside development without logging or consuming the email code", async () => {
    const started = await signup();
    await VerificationCodeModel.updateOne(
      { verificationId: started.verificationId },
      { $set: { resendAvailableAt: new Date(0) } },
    );
    const consoleSpy = vi.spyOn(console, "warn");
    try {
      const result = await request(app)
        .post("/api/auth/user-verify/resend")
        .send({ verificationId: started.verificationId, channel: "phone" });
      expect(result.status).toBe(503);
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(
        (
          await request(app).post("/api/auth/user-verify").send({
            verificationId: started.verificationId,
            code: started.code,
          })
        ).status,
      ).toBe(200);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("allows email and formatted phone login, and honors remember-me cookies", async () => {
    const user = await activeUser();
    const emailLogin = await postLogin(
      ` ${user.body.email.toUpperCase()} `,
      user.body.password,
    );
    expect(emailLogin.status).toBe(200);
    expect(emailLogin.headers["set-cookie"][0].includes("Max-Age")).toBe(false);
    const phoneLogin = await postLogin(
      `${user.body.phone.slice(0, 4)} ${user.body.phone.slice(4)}`,
      user.body.password,
      true,
    );
    expect(phoneLogin.status).toBe(200);
    expect(phoneLogin.headers["set-cookie"][0]).toContain("Max-Age=2592000");
    expect(phoneLogin.body.id).toBe(user.userId);
  });

  it("locks both known and unknown identifiers after five failures for 15 minutes", async () => {
    const user = await activeUser();
    for (const identifier of [user.body.email, "unknown@example.com"]) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const res = await postLogin(identifier, password());
        expect(res.status).toBe(attempt === 5 ? 423 : 401);
        if (attempt < 5) {
          expect(res.body).toMatchObject({
            code: "invalid_credentials",
            message: "Incorrect email or password.",
            attemptsLeft: 5 - attempt,
            lockMinutes: 15,
          });
        } else {
          expect(res.body).toMatchObject({
            code: "locked",
            message: "Too many attempts. Try again in 15 minutes.",
            retryAfterSeconds: 900,
            lockMinutes: 15,
          });
        }
      }
    }
    expect((await postLogin(user.body.email, user.body.password)).status).toBe(
      423,
    );
    await LoginAttemptModel.updateMany(
      {},
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
    expect((await postLogin(user.body.email, user.body.password)).status).toBe(
      200,
    );
  }, 20000);

  it("does not let concurrent wrong logins or verification requests bypass their limits", async () => {
    const user = await activeUser();
    const wrong = password();
    const logins = await Promise.all(
      Array.from({ length: 5 }, () => postLogin(user.body.email, wrong)),
    );
    expect(logins.map((res) => res.status).sort()).toEqual([
      401, 401, 401, 401, 423,
    ]);
    const started = await signup();
    const body = { verificationId: started.verificationId, code: started.code };
    const verified = await Promise.all([
      request(app).post("/api/auth/user-verify").send(body),
      request(app).post("/api/auth/user-verify").send(body),
    ]);
    expect(verified.map((res) => res.status).sort()).toEqual([200, 410]);
  });

  it("checks the database on each request for suspended, deactivated and deleted users", async () => {
    const user = await activeUser();
    for (const status of ["suspended", "deactivated"]) {
      await UserModel.updateOne({ _id: user.userId }, { $set: { status } });
      expect((await postLogin(user.body.email, password())).body.code).toBe(
        "invalid_credentials",
      );
      expect(
        (await postLogin(user.body.email, user.body.password)).body.code,
      ).toBe("suspended");
      expect(
        (await request(app).get("/api/auth/me").set("Cookie", user.cookie))
          .body,
      ).toBeNull();
    }
    await UserModel.deleteOne({ _id: user.userId });
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", user.cookie)).body,
    ).toBeNull();
  });

  it("rejects tampered and expired JWTs", async () => {
    const user = await activeUser();
    const expired = jwt.sign({ version: 0 }, ENV.JWT_SECRET, {
      subject: user.userId,
      issuer: "hip",
      audience: "hip-web",
      expiresIn: -1,
    });
    for (const cookie of [`hip_session=${expired}`, `${user.cookie}tampered`]) {
      expect(
        (await request(app).get("/api/auth/me").set("Cookie", cookie)).body,
      ).toBeNull();
    }
  });

  it("returns the same empty forgot reply for known, unknown and SMTP-failure cases", async () => {
    const user = await activeUser();
    mail.mockClear();
    const unknown = await request(app)
      .post("/api/auth/user-forgot")
      .send({ email: "unknown@example.com" });
    expect(mail).not.toHaveBeenCalled();
    const known = await request(app)
      .post("/api/auth/user-forgot")
      .send({ email: user.body.email });
    const token = latestToken();
    expect(token.length).toBe(64);
    const stored = await PasswordResetModel.findOne({
      userId: user.userId,
    }).select("+tokenHash");
    expect(stored?.tokenHash === token).toBe(false);
    expect((stored?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      29 * 60 * 1000,
    );
    mail.mockRejectedValueOnce(new Error("SMTP unavailable"));
    const failedMail = await request(app)
      .post("/api/auth/user-forgot")
      .send({ email: user.body.email });
    for (const response of [unknown, known, failedMail]) {
      expect(response.status).toBe(204);
      expect(response.text).toBe("");
    }
  });

  it("rejects current-password reuse, allows one reset and revokes existing sessions", async () => {
    const user = await activeUser();
    await request(app)
      .post("/api/auth/user-forgot")
      .send({ email: user.body.email });
    const token = latestToken();
    const reused = await request(app)
      .post("/api/auth/user-reset")
      .send({ token, password: user.body.password });
    expect(reused.status).toBe(400);
    expect(reused.body).toMatchObject({
      code: "password_reused",
      message: "Choose a password you haven’t used on HIP before.",
      field: "password",
    });
    const nextPassword = password();
    const reset = await request(app)
      .post("/api/auth/user-reset")
      .send({ token, password: nextPassword });
    expect(reset.status).toBe(204);
    expect(
      (
        await request(app)
          .post("/api/auth/user-reset")
          .send({ token, password: password() })
      ).body.code,
    ).toBe("token_invalid");
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", user.cookie)).body,
    ).toBeNull();
    expect((await postLogin(user.body.email, user.body.password)).status).toBe(
      401,
    );
    expect((await postLogin(user.body.email, nextPassword)).status).toBe(200);
  });

  it("expires and replaces reset links and consumes a link once under concurrent resets", async () => {
    const user = await activeUser();
    await request(app)
      .post("/api/auth/user-forgot")
      .send({ email: user.body.email });
    const old = latestToken();
    await request(app)
      .post("/api/auth/user-forgot")
      .send({ email: user.body.email });
    const current = latestToken();
    expect(
      (
        await request(app)
          .post("/api/auth/user-reset")
          .send({ token: old, password: password() })
      ).body.code,
    ).toBe("token_invalid");
    await PasswordResetModel.updateOne(
      { userId: user.userId },
      { $set: { expiresAt: new Date(0) } },
    );
    expect(
      (
        await request(app)
          .post("/api/auth/user-reset")
          .send({ token: current, password: password() })
      ).status,
    ).toBe(400);
    await request(app)
      .post("/api/auth/user-forgot")
      .send({ email: user.body.email });
    const token = latestToken();
    const responses = await Promise.all([
      request(app)
        .post("/api/auth/user-reset")
        .send({ token, password: password() }),
      request(app)
        .post("/api/auth/user-reset")
        .send({ token, password: password() }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([204, 400]);
  });

  it("validates request bodies, strips privilege fields and formats JSON and missing-route errors", async () => {
    const invalid = await request(app)
      .post("/api/auth/user-signup")
      .send({ ...credentials(), fullName: "A" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: "validation_error",
      field: "fullName",
      message: "Enter a full name",
      success: false,
      status: 400,
    });
    const body = credentials();
    await request(app)
      .post("/api/auth/user-signup")
      .send({
        ...body,
        roles: ["super_admin"],
        status: "active",
        emailVerified: true,
      });
    const stored = await UserModel.findOne({ email: body.email });
    expect(stored?.roles).toEqual(["hiker"]);
    expect(stored?.status).toBe("unverified");
    const malformed = await request(app)
      .post("/api/auth/user-signup")
      .set("Content-Type", "application/json")
      .send("{");
    expect(malformed.body).toMatchObject({
      code: "validation_error",
      status: 400,
      success: false,
    });
    const missing = await request(app).get("/api/missing");
    expect(missing.body).toEqual({
      message: "Route not found.",
      success: false,
      status: 404,
      code: "not_found",
    });
  });

  it("permits credentialed CORS only for CLIENT_URL", async () => {
    const allowed = await request(app)
      .options("/api/auth/user-login")
      .set("Origin", ENV.CLIENT_URL)
      .set("Access-Control-Request-Method", "POST");
    expect(allowed.headers["access-control-allow-origin"]).toBe(ENV.CLIENT_URL);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    const other = await request(app)
      .get("/api/auth/me")
      .set("Origin", "https://other.example.com");
    expect(
      other.headers["access-control-allow-origin"] ===
        "https://other.example.com",
    ).toBe(false);
  });
});

describe("Environment validation", () => {
  it("refuses production fixed codes, invalid ports, short keys and incomplete SMTP credentials", () => {
    const base = { ...ENV, DEV_FIXED_CODE: undefined };
    expect(
      envSchema.safeParse({
        ...base,
        NODE_ENV: "production",
        DEV_FIXED_CODE: "123456",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...base, NODE_ENV: "production" }).success,
    ).toBe(true);
    for (const PORT of ["5001abc", "", "0", "65536"]) {
      expect(envSchema.safeParse({ ...base, PORT }).success).toBe(false);
    }
    expect(envSchema.safeParse({ ...base, JWT_SECRET: "" }).success).toBe(
      false,
    );
    expect(
      envSchema.safeParse({
        ...base,
        SMTP_PASS: randomBytes(8).toString("hex"),
      }).success,
    ).toBe(false);
  });
});
