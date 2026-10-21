import { randomBytes, createHash } from "crypto";
import { promisify } from "util";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import request from "supertest";
import { generate, generateSecret } from "otplib";
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
import { ENV } from "../config/env";
import { limiter } from "../bootstrap/rate-limiting";
import {
  AdminModel,
  AdminRole,
  type AdminDocument,
} from "../database/models/admin.schema";
import { StaffInviteModel } from "../database/models/staff-invite.schema";
import { StaffChallengeModel } from "../database/models/staff-challenge.schema";
import { AuditLogModel } from "../database/models/audit-log.schema";
import { UserModel } from "../database/models/users.schema";
import { LoginAttemptModel } from "../database/models/login-attempt.schema";
import { sendMail } from "../services/mail.service";
import { createStaffSession } from "../modules/admin/services/auth-session.service";
import { encryptSecret } from "../modules/admin/services/authenticator.service";
import * as auditLog from "../modules/admin/services/audit-log.service";
import { ROLE_PERMISSIONS } from "../shared/permissions/staff-permissions";

vi.mock("../services/mail.service", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
const mail = vi.mocked(sendMail);
let password: string;
let passwordHash: string;
let owner: AdminDocument;
const newPassword = () => `${randomBytes(18).toString("base64url")}1!`;
const cookie = (admin: AdminDocument, scope: "full" | "setup" = "full") =>
  `hip_staff_session=${createStaffSession(admin, scope).token}`;
const responseCookie = (response: request.Response) =>
  String(response.headers["set-cookie"]?.[0] ?? "").split(";")[0];
const member = (role = AdminRole.SUPER_ADMIN, extra = {}) =>
  AdminModel.create({
    fullName: "Current Staff",
    email: `${randomBytes(8).toString("hex")}@example.com`,
    passwordHash,
    role,
    twoStepEnabled: true,
    twoStepEnabledAt: new Date(),
    ...extra,
  });
const inviteBody = (role = AdminRole.ADMIN) => ({
  name: "Invited Staff",
  email: `${randomBytes(8).toString("hex")}@example.com`,
  role,
});
const tokenFromMail = () =>
  mail.mock.calls.at(-1)?.[0].text.match(/token=([a-f\d]{64})/)?.[1] ?? "";
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const invite = (body = inviteBody()) =>
  request(app)
    .post("/api/admin/staff/invites")
    .set("Cookie", cookie(owner))
    .send(body);
const post = (path: string, actor = owner) =>
  request(app)
    .post(`/api/admin/staff/${path}`)
    .set("Cookie", cookie(actor))
    .send({});
const roleChange = (id: string, role = AdminRole.ADMIN, actor = owner) =>
  request(app)
    .put(`/api/admin/staff/${id}/role`)
    .set("Cookie", cookie(actor))
    .send({ role });
const accept = (token: string, value = password) =>
  request(app)
    .post("/api/auth/staff/invites/accept")
    .send({ token, password: value });
const list = (actor = owner) =>
  request(app).get("/api/admin/staff").set("Cookie", cookie(actor));
const actions = [
  ["get", "/api/admin/staff", undefined],
  ["post", "/api/admin/staff/invites", inviteBody()],
  [
    "post",
    "/api/admin/staff/invites/inv_00000000-0000-4000-8000-000000000000/resend",
    {},
  ],
  ["put", "/api/admin/staff/000000000000000000000000/role", { role: "admin" }],
  ["post", "/api/admin/staff/000000000000000000000000/deactivate", {}],
  ["post", "/api/admin/staff/000000000000000000000000/activate", {}],
  ["post", "/api/admin/staff/000000000000000000000000/two-factor/reset", {}],
] as const;

beforeAll(async () => {
  if (
    !/^hip_auth_test(?:_[a-z0-9]+)?$/.test(
      new URL(ENV.MONGODB_URI).pathname.slice(1),
    )
  )
    throw new Error("Staff tests require a dedicated hip_auth_test database.");
  await bootstrap.handleDBConnect();
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName)
    throw new Error("Staff tests require a replica set for real transactions.");
  password = newPassword();
  passwordHash = await promisify(bcrypt.hash)(password, 12);
});
afterAll(async () => {
  await mongoose.disconnect();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  // The application model forbids deletes. Only this dedicated fixture database uses raw cleanup.
  await AuditLogModel.collection.deleteMany({});
  await Promise.all([
    AdminModel.deleteMany({}),
    StaffInviteModel.deleteMany({}),
    StaffChallengeModel.deleteMany({}),
    UserModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
  ]);
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"])
    limiter.resetKey(key);
  mail.mockReset().mockResolvedValue(undefined);
  owner = await member();
});

describe("Staff & roles (ADM-001–ADM-008)", () => {
  it("matches the frontend permission table", () => {
    expect(ROLE_PERMISSIONS).toEqual({
      super_admin: [
        "manage_events",
        "sell_refund_tickets",
        "check_in",
        "correct_attendance",
        "view_analytics",
        "manage_ads",
        "review_ads",
        "manage_settings",
        "view_audit_log",
        "manage_staff",
        "view_hikers",
        "suspend_hikers",
      ],
      admin: [
        "manage_events",
        "sell_refund_tickets",
        "check_in",
        "correct_attendance",
        "view_analytics",
        "manage_ads",
        "review_ads",
        "view_hikers",
        "suspend_hikers",
      ],
      checkin_staff: ["check_in"],
      advertiser: ["manage_ads"],
    });
  });

  it.each([AdminRole.ADMIN, AdminRole.CHECKIN_STAFF, AdminRole.ADVERTISER])(
    "rejects every staff action for %s, before validation or model writes",
    async (role) => {
      const admin = await member(role);
      for (const [method, path, body] of actions) {
        const response = await request(app)
          [method](path)
          .set("Cookie", cookie(admin))
          .send(body);
        expect(response.status).toBe(403);
        expect(response.body).toEqual({
          message: "Only a super admin can manage staff.",
          success: false,
          status: 403,
          code: "forbidden",
        });
      }
      expect(await AuditLogModel.countDocuments()).toBe(0);
      expect(mail).not.toHaveBeenCalled();
    },
  );

  it("requires a current full staff session and keeps hikers separate", async () => {
    for (const [method, path, body] of actions)
      expect((await request(app)[method](path).send(body)).status).toBe(401);
    const limited = await member(AdminRole.SUPER_ADMIN, {
      twoStepEnabled: false,
    });
    expect(
      (
        await request(app)
          .get("/api/admin/staff")
          .set("Cookie", cookie(limited, "setup"))
      ).body.code,
    ).toBe("two_step_required");
    await AdminModel.updateOne(
      { _id: owner._id },
      { $set: { status: "deactivated" } },
    );
    expect((await list()).status).toBe(401);
  });

  it("lists real members and pending invitations with the exact public shape", async () => {
    await member(AdminRole.CHECKIN_STAFF, {
      lastActiveAt: new Date("2026-01-01T09:00:00Z"),
    });
    const created = await invite();
    expect(created.status).toBe(200);
    expect(Object.keys(created.body).sort()).toEqual([
      "email",
      "id",
      "isYou",
      "name",
      "role",
      "status",
      "twoFactor",
    ]);
    expect(created.body).toMatchObject({
      status: "invited",
      isYou: false,
      twoFactor: { setUp: false },
    });
    const result = await list();
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toHaveLength(3);
    expect(result.body[0]).toEqual({
      id: owner.id,
      name: owner.fullName,
      email: owner.email,
      role: "super_admin",
      status: "active",
      lastActiveAt: expect.any(String),
      twoFactor: {
        setUp: true,
        setUpAt: owner.twoStepEnabledAt!.toISOString(),
      },
      isYou: true,
    });
    expect(result.body[1].lastActiveAt).toBe("2026-01-01T09:00:00.000Z");
    expect(result.body[2]).toEqual(created.body);
    expect(JSON.stringify(result.body)).not.toMatch(
      /password|authenticatorSecret|tokenHash|sessionVersion|staffChanges|setupExpires/,
    );
  });

  it("normalizes invites, sends a random 72-hour link, stores only its hash and rejects duplicate staff/pending emails", async () => {
    const body = inviteBody();
    const start = Date.now();
    const result = await invite({
      ...body,
      name: "  Invited Staff  ",
      email: `  ${body.email.toUpperCase()}  `,
    });
    expect(result.status).toBe(200);
    const token = tokenFromMail();
    expect(token).toHaveLength(64);
    expect(mail.mock.calls[0][0].text).toContain(
      `${ENV.CLIENT_URL}/staff/invite?token=`,
    );
    const stored = await StaffInviteModel.findOne({ email: body.email }).select(
      "+tokenHash",
    );
    expect(stored?.tokenHash).toBe(hash(token));
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored!.expiresAt.getTime() - start).toBeGreaterThan(
      71.99 * 3600000,
    );
    expect(stored!.expiresAt.getTime() - start).toBeLessThan(72.01 * 3600000);
    for (const email of [body.email, owner.email]) {
      const duplicate = await invite({ ...body, email });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({
        code: "email_taken",
        field: "email",
        message: "This email already belongs to a staff member or invite.",
      });
    }
    const entry = await AuditLogModel.findOne();
    expect(entry).toMatchObject({
      actor: { id: owner.id, name: owner.fullName, role: "super_admin" },
      action: "staff.invited",
      target: { type: "staff_invite", id: result.body.id },
    });
    expect(JSON.stringify(entry)).not.toContain(token);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("allows a staff invite for a hiker email, without merging the collections", async () => {
    const body = inviteBody();
    await UserModel.create({
      fullName: "Hiker",
      email: body.email,
      phone: "+2348031234567",
      passwordHash,
      emailVerified: true,
    });
    expect((await invite(body)).status).toBe(200);
    expect((await accept(tokenFromMail())).status).toBe(200);
    expect(await AdminModel.countDocuments({ email: body.email })).toBe(1);
    expect(await UserModel.countDocuments({ email: body.email })).toBe(1);
  });

  it("resend replaces the token, renews expiry, returns 204, and accepts only the latest link", async () => {
    const created = await invite();
    const oldToken = tokenFromMail();
    await StaffInviteModel.updateOne(
      { inviteId: created.body.id },
      { $set: { expiresAt: new Date(0) } },
    );
    const resent = await post(`invites/${created.body.id}/resend`);
    expect(resent.status).toBe(204);
    expect(resent.text).toBe("");
    expect(tokenFromMail()).not.toBe(oldToken);
    expect((await accept(oldToken)).status).toBe(410);
    expect((await accept(tokenFromMail())).status).toBe(200);
    expect(
      await AuditLogModel.countDocuments({ action: "staff.invite_resent" }),
    ).toBe(1);
  });

  it("accepts once, creates a password-hashed staff account and grants setup only, then enables the authenticator", async () => {
    const body = inviteBody(AdminRole.CHECKIN_STAFF);
    await invite(body);
    const token = tokenFromMail();
    const accepted = await accept(token);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      fullName: body.name,
      email: body.email,
      roles: ["checkin_staff"],
      status: "active",
    });
    expect(Object.keys(accepted.body).sort()).toEqual([
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
    const limitedCookie = responseCookie(accepted);
    expect(limitedCookie).toMatch(/^hip_staff_session=/);
    expect(accepted.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(accepted.headers["set-cookie"][0]).toContain("SameSite=Lax");
    expect(
      (
        await request(app)
          .get("/api/auth/staff/me")
          .set("Cookie", limitedCookie)
      ).body.code,
    ).toBe("two_step_required");
    expect(
      (await request(app).get("/api/admin/staff").set("Cookie", limitedCookie))
        .body.code,
    ).toBe("two_step_required");
    const stored = await AdminModel.findById(accepted.body.id).select(
      "+passwordHash",
    );
    expect(
      await promisify(bcrypt.compare)(password, stored!.passwordHash),
    ).toBe(true);
    expect((await accept(token)).status).toBe(410);
    const setup = await request(app)
      .post("/api/auth/staff/two-step/setup")
      .set("Cookie", limitedCookie)
      .send({});
    expect(setup.status).toBe(200);
    const enabled = await request(app)
      .post("/api/auth/staff/two-step/enable")
      .set("Cookie", limitedCookie)
      .send({ code: await generate({ secret: setup.body.setupKey }) });
    expect(enabled.status).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/auth/staff/me")
          .set("Cookie", responseCookie(enabled))
      ).body,
    ).toEqual(enabled.body);
    const row = (await list()).body.find(
      (entry: { id: string }) => entry.id === stored!.id,
    );
    expect(row.twoFactor).toEqual({ setUp: true, setUpAt: expect.any(String) });
    expect(row.lastActiveAt).toEqual(expect.any(String));
    expect(
      await AuditLogModel.countDocuments({ action: "staff.invite_accepted" }),
    ).toBe(1);
  });

  it("rejects expired, cancelled, used and malformed tokens with the same error", async () => {
    const created = await invite();
    const token = tokenFromMail();
    await StaffInviteModel.updateOne(
      { inviteId: created.body.id },
      { $set: { expiresAt: new Date(0) } },
    );
    const expired = await accept(token);
    expect(expired.status).toBe(410);
    expect((await accept("invalid")).body).toEqual(expired.body);
    expect((await accept(randomBytes(32).toString("hex"))).body).toEqual(
      expired.body,
    );
    await post(`invites/${created.body.id}/resend`);
    const current = tokenFromMail();
    const cancelled = await post(`${created.body.id}/deactivate`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ ...created.body, status: "deactivated" });
    expect((await accept(current)).body).toEqual(expired.body);
    expect((await list()).body).toHaveLength(1);
    expect((await post(`invites/${created.body.id}/resend`)).status).toBe(404);
    expect(
      await AuditLogModel.countDocuments({ action: "staff.invite_cancelled" }),
    ).toBe(1);
  });

  it("changes account and invitation roles through /role, never /roles", async () => {
    const admin = await member(AdminRole.ADMIN);
    expect(
      (await roleChange(admin.id, AdminRole.ADVERTISER)).body,
    ).toMatchObject({ id: admin.id, role: "advertiser" });
    const existingCookie = cookie(admin);
    expect(
      (await request(app).get("/api/admin/staff").set("Cookie", existingCookie))
        .status,
    ).toBe(403);
    await roleChange(admin.id, AdminRole.SUPER_ADMIN);
    expect(
      (await request(app).get("/api/admin/staff").set("Cookie", existingCookie))
        .status,
    ).toBe(200);
    const created = await invite();
    expect(
      (await roleChange(created.body.id, AdminRole.CHECKIN_STAFF)).body.role,
    ).toBe("checkin_staff");
    expect((await post(`${created.body.id}/activate`)).body.code).toBe(
      "invite_pending",
    );
    expect(
      (
        await request(app)
          .put(`/api/admin/staff/${admin.id}/roles`)
          .set("Cookie", cookie(owner))
          .send({ roles: ["admin"] })
      ).status,
    ).toBe(404);
    expect(
      await AuditLogModel.countDocuments({ action: "staff.role_changed" }),
    ).toBe(3);
  });

  it("never changes your own role or deactivates yourself, including uppercase object IDs", async () => {
    for (const id of [owner.id, owner.id.toUpperCase()]) {
      expect((await roleChange(id)).body).toMatchObject({
        code: "own_role",
        message: "You can’t change your own role. Ask another super admin.",
      });
      expect((await post(`${id}/deactivate`)).body).toMatchObject({
        code: "own_deactivation",
        message: "You can’t deactivate your own account.",
      });
    }
    expect((await AdminModel.findById(owner.id))?.role).toBe("super_admin");
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it.each(["demote", "deactivate"])(
    "preserves the last active super admin during simultaneous mutual %s attempts",
    async (action) => {
      const second = await member();
      const responses = await Promise.all([
        action === "demote"
          ? roleChange(second.id, AdminRole.ADMIN, owner)
          : post(`${second.id}/deactivate`, owner),
        action === "demote"
          ? roleChange(owner.id, AdminRole.ADMIN, second)
          : post(`${owner.id}/deactivate`, second),
      ]);
      expect(
        responses.filter((response) => response.status === 200),
      ).toHaveLength(1);
      expect(
        responses.every((response) =>
          [200, 401, 403, 409].includes(response.status),
        ),
      ).toBe(true);
      expect(
        await AdminModel.countDocuments({
          role: "super_admin",
          status: "active",
        }),
      ).toBe(1);
      expect(await AuditLogModel.countDocuments()).toBe(1);
      const last = await AdminModel.findOne({
        role: "super_admin",
        status: "active",
      }).select("+sessionVersion");
      expect(
        (await roleChange(last!.id, AdminRole.ADMIN, last!)).body.code,
      ).toBe("own_role");
      expect((await post(`${last!.id}/deactivate`, last!)).body.code).toBe(
        "own_deactivation",
      );
    },
  );

  it("deactivation immediately revokes sessions/challenges, reactivation cannot revive them", async () => {
    const admin = await member(AdminRole.ADMIN, { sessionVersion: 7 });
    const oldCookie = cookie(admin);
    await StaffChallengeModel.create({
      adminId: admin._id,
      challengeId: "stf_pending",
      method: "authenticator",
      sessionVersion: 7,
      expiresAt: new Date(Date.now() + 60000),
      resendAvailableAt: new Date(),
    });
    expect((await post(`${admin.id}/deactivate`)).body.status).toBe(
      "deactivated",
    );
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", oldCookie))
        .body,
    ).toBeNull();
    expect(
      await StaffChallengeModel.countDocuments({ adminId: admin._id }),
    ).toBe(0);
    expect(
      (await AdminModel.findById(admin.id).select("+sessionVersion"))
        ?.sessionVersion,
    ).toBe(8);
    expect((await post(`${admin.id}/activate`)).body.status).toBe("active");
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", oldCookie))
        .body,
    ).toBeNull();
    expect(
      await AuditLogModel.countDocuments({
        action: { $in: ["staff.deactivated", "staff.activated"] },
      }),
    ).toBe(2);
  });

  it("reset clears encrypted setup, revokes sessions/challenges, then login emails a code and requires enrollment again", async () => {
    const secret = generateSecret();
    const admin = await member(AdminRole.ADMIN, {
      authenticatorSecret: encryptSecret(secret),
      setupAttempts: 2,
      setupExpiresAt: new Date(),
      sessionVersion: 5,
    });
    const oldCookie = cookie(admin);
    const before = await request(app)
      .post("/api/auth/staff/login")
      .send({ email: admin.email, password });
    expect(before.body.method).toBe("authenticator");
    const reset = await post(`${admin.id}/two-factor/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body.twoFactor).toEqual({ setUp: false });
    const stored = await AdminModel.findById(admin.id).select(
      "+authenticatorSecret +sessionVersion +setupExpiresAt +setupAttempts",
    );
    expect(stored?.authenticatorSecret).toBeUndefined();
    expect(stored?.twoStepEnabledAt).toBeUndefined();
    expect(stored?.setupExpiresAt).toBeUndefined();
    expect(stored?.setupAttempts).toBe(0);
    expect(stored?.sessionVersion).toBe(6);
    expect(
      await StaffChallengeModel.countDocuments({ adminId: admin._id }),
    ).toBe(0);
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", oldCookie))
        .body,
    ).toBeNull();
    const next = await request(app)
      .post("/api/auth/staff/login")
      .send({ email: admin.email, password });
    expect(next.body.method).toBe("email");
    const code = mail.mock.calls.at(-1)?.[0].text.match(/\b\d{6}\b/)?.[0];
    const verified = await request(app)
      .post("/api/auth/staff/verify")
      .send({ challengeId: next.body.challengeId, code });
    expect(verified.status).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/auth/staff/me")
          .set("Cookie", responseCookie(verified))
      ).body.code,
    ).toBe("two_step_required");
    expect(
      await AuditLogModel.countDocuments({ action: "staff.two_factor_reset" }),
    ).toBe(1);
  });

  it("rolls back changes and accepted tokens if the audit insert fails, with a safe 500", async () => {
    const admin = await member(AdminRole.ADMIN);
    const original = auditLog.recordAudit;
    const audit = vi.spyOn(auditLog, "recordAudit");
    audit.mockRejectedValueOnce(new Error("Private connection credentials"));
    const failed = await roleChange(admin.id, AdminRole.ADVERTISER);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain("Private connection");
    expect((await AdminModel.findById(admin.id))?.role).toBe("admin");
    expect(await AuditLogModel.countDocuments()).toBe(0);
    audit.mockImplementation(original);
    await invite();
    const token = tokenFromMail();
    audit.mockRejectedValueOnce(new Error("Private connection credentials"));
    expect((await accept(token)).status).toBe(500);
    expect(await AdminModel.countDocuments()).toBe(2);
    expect(
      (await StaffInviteModel.findOne({ tokenHash: hash(token) }))?.state,
    ).toBe("pending");
    audit.mockImplementation(original);
    expect((await accept(token)).status).toBe(200);
  });

  it("is append-only through document/query/bulk operations and requires an active transaction", async () => {
    await invite();
    const entry = await AuditLogModel.findOne();
    entry!.details = "Rewrite history";
    for (const action of [
      () => entry!.save(),
      () => entry!.deleteOne(),
      () => AuditLogModel.updateOne({}, { $set: { details: "Changed" } }),
      () => AuditLogModel.updateMany({}, { $set: { reason: "Changed" } }),
      () => AuditLogModel.findOneAndUpdate({}, { $set: { reason: "Changed" } }),
      () => AuditLogModel.replaceOne({}, { details: "Changed" }),
      () => AuditLogModel.findOneAndReplace({}, { details: "Changed" }),
      () => AuditLogModel.deleteOne({}),
      () => AuditLogModel.deleteMany({}),
      () => AuditLogModel.findOneAndDelete({}),
      () => AuditLogModel.bulkWrite([{ deleteOne: { filter: {} } }]),
      () => AuditLogModel.aggregate([{ $match: {} }, { $merge: "auditlogs" }]),
      () => AuditLogModel.aggregate([{ $match: {} }, { $out: "auditlogs" }]),
    ])
      await expect(action()).rejects.toThrow(
        "Audit entries cannot be updated or deleted.",
      );
    const session = await mongoose.startSession();
    await expect(
      auditLog.recordAudit(
        owner,
        {
          action: "staff.invited",
          target: { type: "staff", id: owner.id },
          details: "Outside transaction",
        },
        session,
      ),
    ).rejects.toThrow("require a transaction");
    await session.endSession();
    expect(await AuditLogModel.countDocuments()).toBe(1);
    expect((await AuditLogModel.findById(entry!._id))?.details).not.toBe(
      "Rewrite history",
    );
    const listing = await request(app)
      .get("/api/admin/audit-log")
      .set("Cookie", cookie(owner));
    expect(listing.status).toBe(200);
    expect(listing.body.items).toHaveLength(1);
    expect(listing.body.items[0].id).toBe(String(entry!._id));
  });

  it("handles simultaneous duplicate invites and accepts without duplicate accounts, audit records or email sends", async () => {
    const body = inviteBody();
    const invites = await Promise.all([invite(body), invite(body)]);
    expect(invites.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(mail).toHaveBeenCalledTimes(1);
    const token = tokenFromMail();
    const accepted = await Promise.all([accept(token), accept(token)]);
    expect(accepted.map((response) => response.status).sort()).toEqual([
      200, 410,
    ]);
    expect(await AdminModel.countDocuments({ email: body.email })).toBe(1);
    expect(
      await AuditLogModel.countDocuments({ action: "staff.invited" }),
    ).toBe(1);
    expect(
      await AuditLogModel.countDocuments({ action: "staff.invite_accepted" }),
    ).toBe(1);
  });

  it("leaves an auditable pending invite after SMTP failure, so it can be resent, without leaking the error", async () => {
    mail.mockRejectedValueOnce(new Error("Private SMTP password"));
    const body = inviteBody();
    const response = await invite(body);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("Private SMTP");
    const pending = await StaffInviteModel.findOne({ email: body.email });
    expect(pending?.state).toBe("pending");
    expect(
      await AuditLogModel.countDocuments({ action: "staff.invited" }),
    ).toBe(1);
    expect((await post(`invites/${pending!.inviteId}/resend`)).status).toBe(
      204,
    );
  });

  it("validates names, emails, roles, IDs and passwords; missing targets are safe 404s", async () => {
    for (const [patch, field] of [
      [{ name: "x" }, "name"],
      [{ email: "invalid" }, "email"],
      [{ role: "hiker" }, "role"],
    ] as const) {
      const response = await request(app)
        .post("/api/admin/staff/invites")
        .set("Cookie", cookie(owner))
        .send({ ...inviteBody(), ...patch });
      expect(response.status).toBe(400);
      expect(response.body.field).toBe(field);
    }
    expect((await roleChange("bad-id")).body.field).toBe("id");
    expect((await roleChange("000000000000000000000000")).status).toBe(404);
    expect(
      (await post("000000000000000000000000/two-factor/reset")).status,
    ).toBe(404);
    expect((await post("000000000000000000000000/deactivate")).status).toBe(
      404,
    );
    expect(
      (await post("invites/inv_00000000-0000-4000-8000-000000000000/resend"))
        .status,
    ).toBe(404);
    const started = await invite();
    expect(started.status).toBe(200);
    expect((await accept(tokenFromMail(), "short")).body.field).toBe(
      "password",
    );
    expect(
      (await accept(tokenFromMail(), `${password}${"x".repeat(72)}`)).body
        .field,
    ).toBe("password");
  });

  it("records authenticated activity without allowing a revoked cookie to refresh it", async () => {
    const before = new Date("2025-01-01T00:00:00Z");
    const admin = await member(AdminRole.ADMIN, { lastActiveAt: before });
    const session = cookie(admin);
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", session))
        .status,
    ).toBe(200);
    expect(
      (await AdminModel.findById(admin.id))!.lastActiveAt!.getTime(),
    ).toBeGreaterThan(before.getTime());
    await AdminModel.updateOne(
      { _id: admin._id },
      { $set: { lastActiveAt: before }, $inc: { sessionVersion: 1 } },
    );
    expect(
      (await request(app).get("/api/auth/staff/me").set("Cookie", session))
        .body,
    ).toBeNull();
    expect((await AdminModel.findById(admin.id))?.lastActiveAt).toEqual(before);
  });

  it("fails safely without a transaction-capable database and commits nothing", async () => {
    vi.spyOn(mongoose.connection, "transaction").mockRejectedValueOnce(
      new mongoose.mongo.MongoServerError({
        code: 20,
        message: "Private database configuration",
      }),
    );
    const response = await invite();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 503,
      success: false,
      code: "transactions_unavailable",
      message:
        "Staff changes require a MongoDB replica set. Check the database configuration.",
    });
    expect(await StaffInviteModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expect(mail).not.toHaveBeenCalled();
  });
});
