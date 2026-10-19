import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { promisify } from "util";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { generate, generateSecret } from "otplib";
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
import { app } from "../app";
import bootstrap from "../bootstrap";
import { limiter } from "../bootstrap/rate-limiting";
import { ENV, envSchema } from "../config/env";
import { AdminModel, AdminRole } from "../database/models/admin.schema";
import { StaffChallengeModel } from "../database/models/staff-challenge.schema";
import { LoginAttemptModel } from "../database/models/login-attempt.schema";
import { UserModel } from "../database/models/users.schema";
import { AdminSeeder } from "../database/seeders/admin.seeder";
import { sendMail } from "../services/mail.service";
import {
  decryptSecret,
  encryptSecret,
} from "../modules/admin/services/authenticator.service";

vi.mock("../services/mail.service", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
const mail = vi.mocked(sendMail);
const secretPassword = () => `${randomBytes(18).toString("base64url")}1!`;
let passwordHash: string;
let password: string;
const codeFromMail = () =>
  mail.mock.calls.at(-1)?.[0].text.match(/\b\d{6}\b/)?.[0] ?? "";
const cookie = (response: request.Response) =>
  String(response.headers["set-cookie"]?.[0] ?? "").split(";")[0];
const login = (email: string, value = password) =>
  request(app).post("/api/auth/staff/login").send({ email, password: value });
const verify = (challengeId: string, code: string) =>
  request(app).post("/api/auth/staff/verify").send({ challengeId, code });
const staff = (extra = {}) =>
  AdminModel.create({
    fullName: "Sam Hiker",
    email: `staff-${randomBytes(6).toString("hex")}@example.com`,
    passwordHash,
    role: AdminRole.SUPER_ADMIN,
    status: "active",
    ...extra,
  });
const challenge = async (admin: Awaited<ReturnType<typeof staff>>) => {
  const response = await login(admin.email);
  expect(response.status).toBe(200);
  return response.body.challengeId as string;
};
const limited = async () => {
  const admin = await staff();
  const id = await challenge(admin);
  const response = await verify(id, codeFromMail());
  expect(response.status).toBe(200);
  return { admin, id, cookie: cookie(response), response };
};
const enrolled = async (role = AdminRole.SUPER_ADMIN) => {
  const secret = generateSecret();
  const admin = await staff({
    role,
    twoStepEnabled: true,
    authenticatorSecret: encryptSecret(secret),
  });
  return { admin, secret };
};
const wrongCode = async (secret: string) => {
  const epoch = Math.floor(Date.now() / 1000);
  const valid = await Promise.all(
    [-30, 0, 30].map((offset) => generate({ secret, epoch: epoch + offset })),
  );
  let value = 0;
  while (valid.includes(String(value).padStart(6, "0"))) value++;
  return String(value).padStart(6, "0");
};

beforeAll(async () => {
  if (
    !/^hip_auth_test(?:_[a-z0-9]+)?$/.test(
      new URL(ENV.MONGODB_URI).pathname.slice(1),
    )
  )
    throw new Error(
      "Staff auth tests require a dedicated hip_auth_test database.",
    );
  await bootstrap.handleDBConnect();
  password = secretPassword();
  passwordHash = await promisify(bcrypt.hash)(password, 12);
}, 20000);
afterAll(async () => {
  await mongoose.disconnect();
});
beforeEach(async () => {
  await Promise.all([
    AdminModel.deleteMany({}),
    StaffChallengeModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
    UserModel.deleteMany({}),
  ]);
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"])
    limiter.resetKey(key);
  mail.mockReset().mockResolvedValue(undefined);
});

describe("Admin auth (ADM-001)", () => {
  it("rejects password suffixes beyond bcrypt's 72-byte limit with the generic error", async () => {
    const exact = secretPassword().padEnd(72, "x");
    const admin = await staff({
      passwordHash: await promisify(bcrypt.hash)(exact, 12),
    });
    const wrong = await login(admin.email, `${exact}x`);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({
      code: "invalid_credentials",
      attemptsLeft: 4,
    });
    expect(mail).not.toHaveBeenCalled();
    expect((await login(admin.email, exact)).status).toBe(200);
  });

  it("starts with an email challenge, hashes the code and grants only a setup session", async () => {
    const admin = await staff();
    const started = await login(`  ${admin.email.toUpperCase()}  `);
    expect(started.body).toEqual({
      challengeId: expect.any(String),
      method: "email",
      destination: "s•••••@example.com",
    });
    expect(started.headers["set-cookie"]).toBeUndefined();
    expect(mail).toHaveBeenCalledTimes(1);
    const stored = await StaffChallengeModel.findOne({
      adminId: admin._id,
    }).select("+codeHash");
    expect(stored?.codeHash).toHaveLength(64);
    expect(stored?.codeHash).not.toBe(codeFromMail());
    const verified = await verify(started.body.challengeId, codeFromMail());
    expect(Object.keys(verified.body).sort()).toEqual([
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
    expect(verified.body).toMatchObject({
      fullName: admin.fullName,
      email: admin.email,
      roles: ["super_admin"],
      phone: "",
    });
    expect(cookie(verified)).toMatch(/^hip_staff_session=/);
    expect(verified.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(verified.headers["set-cookie"][0]).toContain("SameSite=Lax");
    const me = await request(app)
      .get("/api/auth/staff/me")
      .set("Cookie", cookie(verified));
    expect(me.status).toBe(403);
    expect(me.body.code).toBe("two_step_required");
    expect(
      (await verify(started.body.challengeId, codeFromMail())).status,
    ).toBe(410);
  });

  it("returns a private PNG QR and setup key, enables only after a valid code, then issues a full session", async () => {
    const session = await limited();
    const setup = await request(app)
      .post("/api/auth/staff/two-step/setup")
      .set("Cookie", session.cookie)
      .send({});
    expect(setup.status).toBe(200);
    expect(Object.keys(setup.body).sort()).toEqual(["qrCode", "setupKey"]);
    expect(setup.body.qrCode).toMatch(/^data:image\/png;base64,/);
    expect(
      Buffer.from(setup.body.qrCode.split(",")[1], "base64")
        .subarray(0, 8)
        .toString("hex"),
    ).toBe("89504e470d0a1a0a");
    expect(setup.body.setupKey).toMatch(/^[A-Z2-7]+$/);
    const repeated = await request(app)
      .post("/api/auth/staff/two-step/setup")
      .set("Cookie", session.cookie)
      .send({});
    expect(repeated.body.setupKey).toBe(setup.body.setupKey);
    const stored = await AdminModel.findById(session.admin._id).select(
      "+authenticatorSecret",
    );
    expect(stored?.authenticatorSecret).not.toContain(setup.body.setupKey);
    expect(decryptSecret(stored!.authenticatorSecret!)).toBe(
      setup.body.setupKey,
    );
    expect(stored?.twoStepEnabled).toBe(false);
    const wrong = await request(app)
      .post("/api/auth/staff/two-step/enable")
      .set("Cookie", session.cookie)
      .send({ code: await wrongCode(setup.body.setupKey) });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ code: "invalid_code", attemptsLeft: 4 });
    const enabled = await request(app)
      .post("/api/auth/staff/two-step/enable")
      .set("Cookie", session.cookie)
      .send({ code: await generate({ secret: setup.body.setupKey }) });
    expect(enabled.status).toBe(200);
    const fullCookie = cookie(enabled);
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", fullCookie))
        .body,
    ).toEqual(enabled.body);
    expect(
      (
        await request(app)
          .get("/api/auth/staff/me")
          .set("Cookie", session.cookie)
      ).body,
    ).toBeNull();
    expect(
      (
        await request(app)
          .post("/api/auth/staff/two-step/setup")
          .set("Cookie", fullCookie)
          .send({})
      ).status,
    ).toBe(409);
    expect(enabled.headers["cache-control"]).toBe("no-store");
  });

  it.each(Object.values(AdminRole))(
    "supports %s through authenticator-only login without any email",
    async (role) => {
      const { admin, secret } = await enrolled(role);
      const started = await login(admin.email);
      expect(started.body).toEqual({
        challengeId: expect.any(String),
        method: "authenticator",
      });
      const resend = await request(app)
        .post("/api/auth/staff/verify/resend")
        .send({ challengeId: started.body.challengeId });
      expect(resend.status).toBe(403);
      expect(resend.body.code).toBe("authenticator_required");
      const result = await verify(
        started.body.challengeId,
        await generate({ secret }),
      );
      expect(result.status).toBe(200);
      expect(result.body.roles).toEqual([role]);
      expect(mail).not.toHaveBeenCalled();
      expect(
        (
          await request(app)
            .get("/api/auth/staff/me")
            .set("Cookie", cookie(result))
        ).body,
      ).toEqual(result.body);
    },
  );

  it.each([-30, 30])(
    "accepts one step of clock drift (%s seconds)",
    async (offset) => {
      const { admin, secret } = await enrolled();
      expect(
        (
          await verify(
            await challenge(admin),
            await generate({
              secret,
              epoch: Math.floor(Date.now() / 1000) + offset,
            }),
          )
        ).status,
      ).toBe(200);
    },
  );

  it("rejects an authenticator code outside the one-step window", async () => {
    const { admin, secret } = await enrolled();
    const result = await verify(
      await challenge(admin),
      await generate({ secret, epoch: Math.floor(Date.now() / 1000) - 90 }),
    );
    expect(result.status).toBe(400);
    expect(result.body.message).toBe(
      "That code isn’t right. Check your authenticator app.",
    );
  });

  it("has five email-code tries, expires on the fifth failure and preserves cooldown across login", async () => {
    const admin = await staff();
    const id = await challenge(admin);
    const incorrect = codeFromMail() === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await verify(id, incorrect);
      expect(result.status).toBe(attempt === 5 ? 410 : 400);
      if (attempt < 5) expect(result.body.attemptsLeft).toBe(5 - attempt);
    }
    expect((await verify(id, codeFromMail())).status).toBe(410);
    expect((await login(admin.email)).status).toBe(429);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("uses the same pending challenge on repeated login and enforces a 60-second resend wait", async () => {
    const admin = await staff();
    const id = await challenge(admin);
    expect((await login(admin.email)).body.challengeId).toBe(id);
    const soon = await request(app)
      .post("/api/auth/staff/verify/resend")
      .send({ challengeId: id });
    expect(soon.status).toBe(429);
    expect(soon.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(soon.body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(mail).toHaveBeenCalledTimes(1);
    const oldCode = codeFromMail();
    await StaffChallengeModel.updateOne(
      { challengeId: id },
      { $set: { resendAvailableAt: new Date(Date.now() - 1000) } },
    );
    const sent = await request(app)
      .post("/api/auth/staff/verify/resend")
      .send({ challengeId: id });
    expect(sent.status).toBe(200);
    expect(sent.body.challengeId).toBe(id);
    expect(mail).toHaveBeenCalledTimes(2);
    if (oldCode !== codeFromMail())
      expect((await verify(id, oldCode)).status).toBe(400);
    expect((await verify(id, codeFromMail())).status).toBe(200);
  });

  it("allows only one concurrent resend and one concurrent successful verification", async () => {
    const admin = await staff();
    const id = await challenge(admin);
    await StaffChallengeModel.updateOne(
      { challengeId: id },
      { $set: { resendAvailableAt: new Date(Date.now() - 1000) } },
    );
    const resends = await Promise.all(
      [1, 2].map(() =>
        request(app)
          .post("/api/auth/staff/verify/resend")
          .send({ challengeId: id }),
      ),
    );
    expect(resends.map((result) => result.status).sort()).toEqual([200, 429]);
    const responses = await Promise.all(
      [1, 2].map(() => verify(id, codeFromMail())),
    );
    expect(responses.map((result) => result.status).sort()).toEqual([200, 410]);
  });

  it("rolls back a failed resend and removes a challenge when first delivery fails", async () => {
    const admin = await staff();
    const id = await challenge(admin);
    const originalCode = codeFromMail();
    await StaffChallengeModel.updateOne(
      { challengeId: id },
      { $set: { resendAvailableAt: new Date(Date.now() - 1000) } },
    );
    mail.mockRejectedValueOnce(new Error("Private SMTP credentials"));
    const resend = await request(app)
      .post("/api/auth/staff/verify/resend")
      .send({ challengeId: id });
    expect(resend.status).toBe(500);
    expect(JSON.stringify(resend.body)).not.toContain("Private SMTP");
    expect((await verify(id, originalCode)).status).toBe(200);
    mail.mockRejectedValueOnce(new Error("Private SMTP credentials"));
    expect((await login(admin.email)).status).toBe(500);
    expect(
      await StaffChallengeModel.countDocuments({ adminId: admin._id }),
    ).toBe(0);
  });

  it("locks wrong passwords after five failures for 15 minutes, even for an unknown email", async () => {
    const admin = await staff();
    for (const email of [admin.email, "unknown@example.com"]) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const result = await login(email, secretPassword());
        expect(result.status).toBe(attempt === 5 ? 423 : 401);
        if (attempt < 5)
          expect(result.body).toMatchObject({
            code: "invalid_credentials",
            message: "Incorrect email or password.",
            attemptsLeft: 5 - attempt,
          });
        else
          expect(result.body).toMatchObject({
            code: "locked",
            lockMinutes: 15,
            retryAfterSeconds: 900,
          });
      }
    }
    expect((await login(admin.email)).status).toBe(423);
    await LoginAttemptModel.updateMany(
      {},
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
    expect((await login(admin.email)).status).toBe(200);
  });

  it("deactivated staff cannot log in, complete a challenge, or use an existing session", async () => {
    const { admin, secret } = await enrolled();
    const id = await challenge(admin);
    const full = await verify(id, await generate({ secret }));
    const second = await challenge(admin);
    await AdminModel.updateOne(
      { _id: admin._id },
      { $set: { status: "deactivated" } },
    );
    expect((await login(admin.email, secretPassword())).status).toBe(401);
    const inactive = await login(admin.email);
    expect(inactive.status).toBe(403);
    expect(inactive.body).toMatchObject({
      code: "suspended",
      message: "This staff account is deactivated. Ask a super admin.",
    });
    expect((await verify(second, await generate({ secret }))).status).toBe(410);
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", cookie(full)))
        .body,
    ).toBeNull();
  });

  it("separates hiker and staff passwords, cookie audiences and lockout counters", async () => {
    const { admin, secret } = await enrolled();
    const hiker = await UserModel.create({
      fullName: "Hiker Test",
      email: admin.email,
      phone: "+2348030000000",
      passwordHash,
      roles: ["hiker"],
      status: "active",
      emailVerified: true,
    });
    await login(admin.email, secretPassword());
    const hikerLogin = await request(app)
      .post("/api/auth/user-login")
      .send({ identifier: hiker.email, password, remember: false });
    expect(hikerLogin.status).toBe(200);
    const hikerCookie = cookie(hikerLogin);
    const full = await verify(
      await challenge(admin),
      await generate({ secret }),
    );
    const staffCookie = cookie(full);
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", staffCookie)).body,
    ).toBeNull();
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", hikerCookie))
        .body,
    ).toBeNull();
    expect(
      (await request(app).get("/api/me/profile").set("Cookie", staffCookie))
        .status,
    ).toBe(401);
    const hikerTokenAsStaff = hikerCookie.replace(
      /^hip_session=/,
      "hip_staff_session=",
    );
    expect(
      (
        await request(app)
          .get("/api/auth/staff/me")
          .set("Cookie", hikerTokenAsStaff)
      ).body,
    ).toBeNull();
    await request(app)
      .post("/api/auth/staff/logout")
      .set("Cookie", `${hikerCookie}; ${staffCookie}`)
      .send({});
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", hikerCookie)).body
        .id,
    ).toBe(hiker.id);
    await UserModel.deleteOne({ _id: hiker._id });
    expect(
      (
        await request(app)
          .post("/api/auth/user-login")
          .send({ identifier: admin.email, password })
      ).status,
    ).toBe(401);
    const onlyHiker = await UserModel.create({
      fullName: "Only Hiker",
      email: "only-hiker@example.com",
      phone: "+2348030000001",
      passwordHash,
      status: "active",
    });
    expect((await login(onlyHiker.email)).status).toBe(401);
  });

  it("logout is idempotent and invalidates copied staff cookies without returning tokens", async () => {
    const { admin, secret } = await enrolled();
    const signed = await verify(
      await challenge(admin),
      await generate({ secret }),
    );
    const saved = cookie(signed);
    const logout = await request(app)
      .post("/api/auth/staff/logout")
      .set("Cookie", saved)
      .send({});
    expect(logout.status).toBe(204);
    expect(logout.text).toBe("");
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", saved)).body,
    ).toBeNull();
    expect(
      (await request(app).post("/api/auth/staff/logout").send({})).status,
    ).toBe(204);
    expect((await request(app).get("/api/auth/staff/me")).body).toBeNull();
  });

  it("checks deletion and session version on every request, and refuses forged full sessions", async () => {
    const session = await limited();
    const forged = jwt.sign({ version: 0, scope: "full" }, ENV.JWT_SECRET, {
      subject: session.admin.id,
      audience: "hip-staff",
      issuer: "hip",
    });
    expect(
      (
        await request(app)
          .get("/api/auth/staff/me")
          .set("Cookie", `hip_staff_session=${forged}`)
      ).body,
    ).toBeNull();
    await AdminModel.deleteOne({ _id: session.admin._id });
    expect(
      (
        await request(app)
          .post("/api/auth/staff/two-step/setup")
          .set("Cookie", session.cookie)
          .send({})
      ).status,
    ).toBe(401);
  });

  it("checks expiry for email challenges and setup secrets", async () => {
    const admin = await staff();
    const id = await challenge(admin);
    await StaffChallengeModel.updateOne(
      { challengeId: id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await verify(id, codeFromMail())).status).toBe(410);
    const session = await limited();
    await request(app)
      .post("/api/auth/staff/two-step/setup")
      .set("Cookie", session.cookie)
      .send({});
    await AdminModel.updateOne(
      { _id: session.admin._id },
      { $set: { setupExpiresAt: new Date(Date.now() - 1000) } },
    );
    expect(
      (
        await request(app)
          .post("/api/auth/staff/two-step/enable")
          .set("Cookie", session.cookie)
          .send({ code: "123456" })
      ).status,
    ).toBe(410);
  });

  it("rejects malformed input before any database or email work", async () => {
    expect((await login("not-an-email")).status).toBe(400);
    const malformed = await verify("some-challenge", "12345");
    expect(malformed.status).toBe(400);
    expect(malformed.body.field).toBe("code");
    expect(mail).not.toHaveBeenCalled();
  });

  it("uses DEV_FIXED_CODE only for development email codes, never for authenticators", async () => {
    const previous = {
      NODE_ENV: ENV.NODE_ENV,
      DEV_FIXED_CODE: ENV.DEV_FIXED_CODE,
    };
    ENV.NODE_ENV = "development";
    ENV.DEV_FIXED_CODE = "123456";
    try {
      await challenge(await staff());
      expect(codeFromMail()).toBe("123456");
      const { admin, secret } = await enrolled();
      const id = await challenge(admin);
      const actual = await generate({ secret });
      if (actual !== "123456")
        expect((await verify(id, "123456")).status).toBe(400);
      expect((await verify(id, actual)).status).toBe(200);
    } finally {
      Object.assign(ENV, previous);
    }
  });

  it("seeds only the configured super admin and never overwrites an existing account", async () => {
    const seedEnv = {
      SUPER_ADMIN_EMAIL: ENV.SUPER_ADMIN_EMAIL,
      SUPER_ADMIN_NAME: ENV.SUPER_ADMIN_NAME,
      SUPER_ADMIN_PASSWORD: ENV.SUPER_ADMIN_PASSWORD,
    };
    const seedPassword = secretPassword();
    Object.assign(ENV, {
      SUPER_ADMIN_EMAIL: "seed@example.com",
      SUPER_ADMIN_NAME: "Seeded Owner",
      SUPER_ADMIN_PASSWORD: seedPassword,
    });
    try {
      await AdminSeeder();
      const seeded = await AdminModel.findOne({
        email: "seed@example.com",
      }).select("+passwordHash");
      expect(seeded).toMatchObject({
        fullName: "Seeded Owner",
        role: "super_admin",
        status: "active",
        twoStepEnabled: false,
      });
      expect(
        await promisify(bcrypt.compare)(seedPassword, seeded!.passwordHash),
      ).toBe(true);
      await AdminModel.updateOne(
        { _id: seeded!._id },
        { $set: { fullName: "Owner Changed", status: "deactivated" } },
      );
      ENV.SUPER_ADMIN_NAME = "Should Not Overwrite";
      await AdminSeeder();
      expect(await AdminModel.countDocuments({})).toBe(1);
      expect(await AdminModel.findById(seeded!._id)).toMatchObject({
        fullName: "Owner Changed",
        status: "deactivated",
      });
    } finally {
      Object.assign(ENV, seedEnv);
    }
  });
});

describe("Staff configuration and encryption", () => {
  it("authenticates encrypted secrets and uses a fresh IV each time", () => {
    const secret = generateSecret();
    const first = encryptSecret(secret);
    expect(first).not.toBe(encryptSecret(secret));
    expect(decryptSecret(first)).toBe(secret);
    const parts = first.split(":");
    parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
    expect(() => decryptSecret(parts.join(":"))).toThrow();
    expect(() => decryptSecret("invalid")).toThrow();
  });

  it("validates the encryption key and all-or-none seeder credentials", () => {
    expect(
      envSchema.safeParse({ ...ENV, ENCRYPTION_KEY: "short" }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...ENV,
        SUPER_ADMIN_EMAIL: "seed@example.com",
        SUPER_ADMIN_NAME: undefined,
        SUPER_ADMIN_PASSWORD: undefined,
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...ENV,
        SUPER_ADMIN_EMAIL: "",
        SUPER_ADMIN_NAME: "",
        SUPER_ADMIN_PASSWORD: "",
      }).success,
    ).toBe(true);
  });
});
