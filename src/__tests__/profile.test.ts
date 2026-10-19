import { randomBytes, randomInt } from "crypto";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import request from "supertest";
import {
  afterAll,
  afterEach,
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
import { ENV } from "../config/env";
import { UserModel, type UserDocument } from "../database/models/users.schema";
import { ContactChangeModel } from "../database/models/contact-change.schema";
import { PasswordResetModel } from "../database/models/password-reset.schema";
import { VerificationCodeModel } from "../database/models/verification-code.schema";
import { Role } from "../shared/enums/user-role.enum";
import { AppError } from "../shared/errors/app.error";
import { createSession } from "../modules/users/services/auth-session.service";
import { sendMail } from "../services/mail.service";

vi.mock("../services/mail.service", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
const mail = vi.mocked(sendMail);
const password = `${randomBytes(18).toString("base64url")}1!`;
let passwordHash: string;
const originalEnv = { node: ENV.NODE_ENV, code: ENV.DEV_FIXED_CODE };
const prefs = {
  ticketConfirmations: true,
  reminders: true,
  reminderChannel: "email_whatsapp",
  promotions: false,
};
const cookie = (user: UserDocument) =>
  `hip_session=${createSession(user).token}`;
const values = (user: UserDocument, extra = {}) => ({
  fullName: user.fullName,
  email: user.email,
  phone: user.phone,
  ...extra,
});
const latestCode = () =>
  mail.mock.calls.at(-1)?.[0].text.match(/\b\d{6}\b/)?.[0] ?? "";
const nextEmail = () => `change-${randomBytes(8).toString("hex")}@example.com`;
const nextPhone = () => `+234803${randomInt(1000000, 10000000)}`;
const patch = (user: UserDocument, extra = {}) =>
  request(app)
    .patch("/api/me/profile")
    .set("Cookie", cookie(user))
    .send(values(user, extra));
const confirm = (user: UserDocument, verificationId: string, code: string) =>
  request(app)
    .post("/api/me/contact/verify")
    .set("Cookie", cookie(user))
    .send({ verificationId, code });
const resend = (user: UserDocument, verificationId: string) =>
  request(app)
    .post("/api/me/contact/resend")
    .set("Cookie", cookie(user))
    .send({ verificationId });
const fixture = () =>
  UserModel.create({
    fullName: "Ada Okafor",
    email: nextEmail(),
    phone: nextPhone(),
    passwordHash,
    status: "active",
    emailVerified: true,
  });

beforeAll(async () => {
  if (
    !/^hip_auth_test(?:_[a-z0-9]+)?$/.test(
      new URL(ENV.MONGODB_URI).pathname.slice(1),
    )
  )
    throw new Error(
      "Profile tests require a dedicated hip_auth_test database.",
    );
  await bootstrap.handleDBConnect();
  passwordHash = await bcrypt.hash(password, 12);
});
afterAll(async () => {
  await mongoose.disconnect();
});
beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    ContactChangeModel.deleteMany({}),
    PasswordResetModel.deleteMany({}),
    VerificationCodeModel.deleteMany({}),
  ]);
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"])
    limiter.resetKey(key);
  mail.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  ENV.NODE_ENV = originalEnv.node;
  ENV.DEV_FIXED_CODE = originalEnv.code;
  vi.restoreAllMocks();
});

describe("Profile authentication", () => {
  it.each([
    ["get", "/profile"],
    ["patch", "/profile"],
    ["post", "/contact/verify"],
    ["post", "/contact/resend"],
    ["delete", "/contact/cv_missing"],
    ["get", "/notifications"],
    ["put", "/notifications"],
  ] as const)("requires a session for %s %s", async (method, path) => {
    const response = await request(app)[method](`/api/me${path}`).send({});
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      message: "Please log in to continue.",
      success: false,
      status: 401,
      code: "unauthenticated",
    });
  });

  it("rejects staff and invalid, deleted or inactive sessions", async () => {
    const user = await fixture();
    const session = cookie(user);
    await UserModel.updateOne({ _id: user.id }, { roles: [Role.ADMIN] });
    expect(
      (await request(app).get("/api/me/profile").set("Cookie", session)).status,
    ).toBe(403);
    for (const status of ["suspended", "deactivated", "unverified"]) {
      await UserModel.updateOne(
        { _id: user.id },
        { roles: [Role.HIKER], status },
      );
      expect(
        (await request(app).get("/api/me/profile").set("Cookie", session))
          .status,
      ).toBe(401);
    }
    await UserModel.deleteOne({ _id: user.id });
    expect(
      (await request(app).get("/api/me/profile").set("Cookie", session)).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/me/profile")
          .set("Cookie", "hip_session=invalid")
      ).status,
    ).toBe(401);
  });
});

describe("AUTH-016 — profile", () => {
  it("returns the exact HikerProfile shape with defaults and no private fields", async () => {
    const user = await fixture();
    const response = await request(app)
      .get("/api/me/profile")
      .set("Cookie", cookie(user));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        roles: ["hiker"],
        status: "active",
        emailVerified: true,
        phoneVerified: false,
        createdAt: user.createdAt.toISOString(),
      },
      hikesAttended: 0,
      notifications: prefs,
      pendingContacts: [],
    });
  });

  it("saves validated details, clears optional details when omitted and blocks mass assignment", async () => {
    const user = await fixture();
    const response = await patch(user, {
      fullName: "  Ada Updated  ",
      dateOfBirth: "1995-02-28",
      emergencyContact: { name: "  Chidi Okafor ", phone: "+234 802-111 2233" },
      roles: ["super_admin"],
      status: "suspended",
      emailVerified: false,
      passwordHash: "ignored",
    });
    expect(response.status).toBe(200);
    expect(response.body.dateOfBirth).toBe("1995-02-28");
    expect(response.body.emergencyContact).toEqual({
      name: "Chidi Okafor",
      phone: "+2348021112233",
    });
    expect(response.body.user).toMatchObject({
      fullName: "Ada Updated",
      roles: ["hiker"],
      status: "active",
      emailVerified: true,
    });
    expect(
      (await UserModel.findById(user.id).select("+passwordHash"))
        ?.passwordHash === passwordHash,
    ).toBe(true);
    const cleared = await patch(user);
    expect(cleared.body).not.toHaveProperty("dateOfBirth");
    expect(cleared.body).not.toHaveProperty("emergencyContact");
    expect(mail).not.toHaveBeenCalled();
  });

  it.each([
    [{ fullName: " " }, "fullName"],
    [{ fullName: "x".repeat(81) }, "fullName"],
    [{ email: "invalid" }, "email"],
    [{ phone: "123" }, "phone"],
    [{ dateOfBirth: "2001-02-29" }, "dateOfBirth"],
    [{ dateOfBirth: "2999-01-01" }, "dateOfBirth"],
    [{ dateOfBirth: "1899-12-31" }, "dateOfBirth"],
    [{ dateOfBirth: "01/02/1990" }, "dateOfBirth"],
    [{ emergencyContact: { name: "Chidi" } }, "emergencyContact.phone"],
    [
      { emergencyContact: { name: "", phone: "+2348021112233" } },
      "emergencyContact.name",
    ],
    [
      { emergencyContact: { name: "Chidi", phone: "123" } },
      "emergencyContact.phone",
    ],
  ])("validates each profile field %#", async (extra, field) => {
    const user = await fixture();
    const response = await patch(user, extra);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "validation_error", field });
    expect(mail).not.toHaveBeenCalled();
  });

  it("rejects the current or proposed own phone as an emergency number", async () => {
    const user = await fixture();
    for (const phone of [user.phone, nextPhone()]) {
      const response = await patch(user, {
        phone,
        emergencyContact: { name: "Chidi", phone: user.phone },
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: "validation_error",
        field: "emergencyContact.phone",
      });
    }
    const phone = nextPhone();
    expect(
      (await patch(user, { phone, emergencyContact: { name: "Chidi", phone } }))
        .status,
    ).toBe(400);
  });

  it("does not implement photo, export or account deletion", async () => {
    const user = await fixture();
    expect(
      (await request(app).post("/api/me/photo").set("Cookie", cookie(user)))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get("/api/me/export").set("Cookie", cookie(user)))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/api/me/delete")
          .set("Cookie", cookie(user))
          .send({ password })
      ).status,
    ).toBe(404);
  });
});

describe("AUTH-017 — contact changes", () => {
  it("sends to the new email, hashes its code, keeps the old contact until verification and then changes login", async () => {
    const user = await fixture();
    const email = nextEmail();
    const started = await patch(user, { email });
    expect(started.status).toBe(200);
    expect(started.body.user.email === user.email).toBe(true);
    expect(mail.mock.calls[0][0].to === email).toBe(true);
    expect(started.body.pendingContacts[0]).toMatchObject({
      field: "email",
      value: email,
    });
    const id = started.body.pendingContacts[0].verificationId;
    const code = latestCode();
    const stored = await ContactChangeModel.findOne({
      verificationId: id,
    }).select("+codeHash");
    expect(
      Boolean(
        stored?.codeHash &&
          stored.codeHash !== code &&
          stored.codeHash.length === 64,
      ),
    ).toBe(true);
    expect(Object.keys(started.body.pendingContacts[0]).sort()).toEqual([
      "field",
      "resendAvailableAt",
      "value",
      "verificationId",
    ]);
    const verified = await confirm(user, id, code);
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ email, emailVerified: true });
    expect(verified.body.pendingContacts).toEqual([]);
    expect((await confirm(user, id, code)).status).toBe(410);
    const login = await request(app)
      .post("/api/auth/user-login")
      .send({ identifier: email, password });
    expect(login.status).toBe(200);
    expect(
      (
        await request(app)
          .post("/api/auth/user-login")
          .send({ identifier: user.email, password })
      ).status,
    ).toBe(401);
  });

  it("does not reset attempts or resend when the same pending value is saved again", async () => {
    const user = await fixture();
    const email = nextEmail();
    const first = await patch(user, { email });
    const id = first.body.pendingContacts[0].verificationId;
    await ContactChangeModel.updateOne({ verificationId: id }, { attempts: 3 });
    const again = await patch(user, { email });
    expect(again.body.pendingContacts).toEqual(first.body.pendingContacts);
    expect(
      (await ContactChangeModel.findOne({ verificationId: id }))?.attempts,
    ).toBe(3);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("returns attemptsLeft and expires after five wrong codes", async () => {
    const user = await fixture();
    const started = await patch(user, { email: nextEmail() });
    const id = started.body.pendingContacts[0].verificationId;
    const correct = latestCode();
    const wrong = correct === "000000" ? "999999" : "000000";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await confirm(user, id, wrong);
      expect(response.status).toBe(attempt < 5 ? 400 : 410);
      expect(response.body.code).toBe(
        attempt < 5 ? "invalid_code" : "code_expired",
      );
      if (attempt < 5) expect(response.body.attemptsLeft).toBe(5 - attempt);
    }
    expect((await confirm(user, id, correct)).status).toBe(410);
    expect((await UserModel.findById(user.id))?.email === user.email).toBe(
      true,
    );
    expect(await ContactChangeModel.countDocuments({ userId: user.id })).toBe(
      0,
    );
  });

  it("enforces expiry independently of MongoDB TTL cleanup", async () => {
    const user = await fixture();
    const started = await patch(user, { email: nextEmail() });
    const id = started.body.pendingContacts[0].verificationId;
    await ContactChangeModel.updateOne(
      { verificationId: id },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    expect((await confirm(user, id, latestCode())).status).toBe(410);
    expect((await resend(user, id)).status).toBe(410);
    expect(
      (await request(app).get("/api/me/profile").set("Cookie", cookie(user)))
        .body.pendingContacts,
    ).toEqual([]);
  });

  it("rate limits resends, retains the ID, resets attempts and invalidates the previous code", async () => {
    ENV.NODE_ENV = "development";
    ENV.DEV_FIXED_CODE = "123456";
    const user = await fixture();
    const started = await patch(user, { email: nextEmail() });
    const id = started.body.pendingContacts[0].verificationId;
    const early = await resend(user, id);
    expect(early.status).toBe(429);
    expect(early.body.message).toBe(
      "Please wait a moment before asking for another code.",
    );
    expect(early.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(early.body.retryAfterSeconds).toBeLessThanOrEqual(60);
    await ContactChangeModel.updateOne(
      { verificationId: id },
      { resendAvailableAt: new Date(Date.now() - 1000), attempts: 3 },
    );
    ENV.DEV_FIXED_CODE = "654321";
    const resent = await resend(user, id);
    expect(resent.status).toBe(200);
    expect(resent.body.pendingContacts[0].verificationId).toBe(id);
    expect(
      (await ContactChangeModel.findOne({ verificationId: id }))?.attempts,
    ).toBe(0);
    expect((await confirm(user, id, "123456")).status).toBe(400);
    expect((await confirm(user, id, "654321")).status).toBe(200);
  });

  it("rejects duplicate verified contacts both before sending and at confirmation", async () => {
    const user = await fixture();
    const other = await fixture();
    for (const field of ["email", "phone"] as const) {
      const duplicate = await patch(user, { [field]: other[field] });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({ code: `${field}_taken`, field });
    }
    expect(mail).not.toHaveBeenCalled();
    const email = nextEmail();
    const started = await patch(user, { email });
    await UserModel.updateOne({ _id: other.id }, { email });
    const collision = await confirm(
      user,
      started.body.pendingContacts[0].verificationId,
      latestCode(),
    );
    expect(collision.status).toBe(409);
    expect(collision.body).toMatchObject({
      code: "email_taken",
      field: "email",
    });
    expect((await UserModel.findById(user.id))?.email === user.email).toBe(
      true,
    );
  });

  it("allows a proven email to replace an unfinished signup", async () => {
    const user = await fixture();
    const draft = await fixture();
    await UserModel.updateOne(
      { _id: draft.id },
      { status: "unverified", emailVerified: false },
    );
    const started = await patch(user, { email: draft.email });
    expect(started.status).toBe(200);
    expect(
      (
        await confirm(
          user,
          started.body.pendingContacts[0].verificationId,
          latestCode(),
        )
      ).status,
    ).toBe(200);
    expect(await UserModel.exists({ _id: draft.id })).toBeNull();
  });

  it("scopes contact verification, resend and cancellation to the owner", async () => {
    const user = await fixture();
    const other = await fixture();
    const started = await patch(user, { email: nextEmail() });
    const id = started.body.pendingContacts[0].verificationId;
    expect((await confirm(other, id, latestCode())).status).toBe(410);
    expect((await resend(other, id)).status).toBe(410);
    const cancelledByOther = await request(app)
      .delete(`/api/me/contact/${id}`)
      .set("Cookie", cookie(other));
    expect(cancelledByOther.status).toBe(200);
    expect(await ContactChangeModel.countDocuments({ userId: user.id })).toBe(
      1,
    );
    const cancelled = await request(app)
      .delete(`/api/me/contact/${id}`)
      .set("Cookie", cookie(user));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.pendingContacts).toEqual([]);
    expect((await confirm(user, id, latestCode())).status).toBe(410);
  });

  it("invalidates a replaced change, and saving the current contact cancels it", async () => {
    const user = await fixture();
    const first = await patch(user, { email: nextEmail() });
    const id = first.body.pendingContacts[0].verificationId;
    const previousCode = latestCode();
    const second = await patch(user, { email: nextEmail() });
    expect(second.status).toBe(200);
    expect((await confirm(user, id, previousCode)).status).toBe(410);
    expect((await patch(user)).body.pendingContacts).toEqual([]);
  });

  it("consumes a code only once under concurrent confirmations and sends only one concurrent resend", async () => {
    const user = await fixture();
    const started = await patch(user, { email: nextEmail() });
    const id = started.body.pendingContacts[0].verificationId;
    await ContactChangeModel.updateOne(
      { verificationId: id },
      { resendAvailableAt: new Date(Date.now() - 1000) },
    );
    const responses = await Promise.all([resend(user, id), resend(user, id)]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 429,
    ]);
    expect(mail).toHaveBeenCalledTimes(2);
    const code = latestCode();
    const confirmed = await Promise.all([
      confirm(user, id, code),
      confirm(user, id, code),
    ]);
    expect(confirmed.map((response) => response.status).sort()).toEqual([
      200, 410,
    ]);
  });

  it("verifies a phone using the development helper without logging email codes", async () => {
    ENV.NODE_ENV = "development";
    ENV.DEV_FIXED_CODE = "123456";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = await fixture();
    const phone = nextPhone();
    const started = await patch(user, { phone });
    expect(started.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(mail).not.toHaveBeenCalled();
    const verified = await confirm(
      user,
      started.body.pendingContacts[0].verificationId,
      "123456",
    );
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({
      phone,
      phoneVerified: true,
      emailVerified: true,
    });
  });

  it("rejects phone delivery outside development and leaves the profile unchanged on mail failure", async () => {
    ENV.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = await fixture();
    expect((await patch(user, { phone: nextPhone() })).status).toBe(503);
    expect(warn).not.toHaveBeenCalled();
    expect(await ContactChangeModel.countDocuments()).toBe(0);
    mail.mockRejectedValueOnce(
      new AppError(
        503,
        "mail_unavailable",
        "We couldn’t send your email. Please try again shortly.",
      ),
    );
    expect(
      (await patch(user, { fullName: "Not saved", email: nextEmail() })).status,
    ).toBe(503);
    expect((await UserModel.findById(user.id))?.fullName).toBe(user.fullName);
    expect(await ContactChangeModel.countDocuments()).toBe(0);
  });
});

describe("NOT-010 — notification preferences", () => {
  it("returns defaults, saves optional preferences, and forces ticket confirmations on", async () => {
    const user = await fixture();
    const initial = await request(app)
      .get("/api/me/notifications")
      .set("Cookie", cookie(user));
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual(prefs);
    const response = await request(app)
      .put("/api/me/notifications")
      .set("Cookie", cookie(user))
      .send({
        ticketConfirmations: false,
        reminders: false,
        reminderChannel: "email",
        promotions: true,
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ticketConfirmations: true,
      reminders: false,
      reminderChannel: "email",
      promotions: true,
    });
    expect(
      (await request(app).get("/api/me/profile").set("Cookie", cookie(user)))
        .body.notifications,
    ).toEqual(response.body);
    expect(
      (await UserModel.findById(user.id))?.notifications.ticketConfirmations,
    ).toBe(true);
  });

  it.each([
    [
      { reminders: "false", reminderChannel: "email", promotions: false },
      "reminders",
    ],
    [
      { reminders: true, reminderChannel: "sms", promotions: false },
      "reminderChannel",
    ],
    [
      { reminders: true, reminderChannel: "email", promotions: "true" },
      "promotions",
    ],
  ])("rejects invalid preferences %#", async (body, field) => {
    const user = await fixture();
    const response = await request(app)
      .put("/api/me/notifications")
      .set("Cookie", cookie(user))
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "validation_error", field });
  });
});
