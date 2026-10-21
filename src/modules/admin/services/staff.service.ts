import { createHash, randomBytes, randomUUID } from "crypto";
import { promisify } from "util";
import bcrypt from "bcrypt";
import mongoose, { type ClientSession } from "mongoose";
import { ENV } from "../../../config/env";
import {
  AdminModel,
  AdminRole,
  toStaffResponse,
  type AdminDocument,
} from "../../../database/models/admin.schema";
import {
  StaffInviteModel,
  type StaffInviteDocument,
} from "../../../database/models/staff-invite.schema";
import { StaffChallengeModel } from "../../../database/models/staff-challenge.schema";
import { AppError } from "../../../shared/errors/app.error";
import { sendMail } from "../../../services/mail.service";
import { recordAudit } from "./audit-log.service";
import { createStaffSession } from "./auth-session.service";
import { staffPermissionError } from "../middleware/permission.middleware";

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("hex");
const expiry = () => new Date(Date.now() + 72 * 60 * 60 * 1000);
const missingStaff = () =>
  new AppError(404, "not_found", "Staff member not found.");
const missingInvite = () => new AppError(404, "not_found", "Invite not found.");
const invalidInvite = () =>
  new AppError(
    410,
    "invite_expired",
    "This invite is invalid or has expired. Ask a super admin for a new invite.",
  );
const emailTaken = () =>
  new AppError(
    409,
    "email_taken",
    "This email already belongs to a staff member or invite.",
    { field: "email" },
  );
const lastSuperAdmin = () =>
  new AppError(
    409,
    "last_super_admin",
    "There must always be at least one active super admin.",
  );

export const staffMemberResponse = (
  admin: AdminDocument,
  viewerId: string,
) => ({
  id: admin.id as string,
  name: admin.fullName,
  email: admin.email,
  role: admin.role,
  status: admin.status,
  ...(admin.lastActiveAt
    ? { lastActiveAt: admin.lastActiveAt.toISOString() }
    : {}),
  twoFactor: {
    setUp: admin.twoStepEnabled,
    ...(admin.twoStepEnabled && admin.twoStepEnabledAt
      ? { setUpAt: admin.twoStepEnabledAt.toISOString() }
      : {}),
  },
  isYou: admin.id === viewerId,
});
const inviteResponse = (
  invite: StaffInviteDocument,
  status: "invited" | "deactivated" = "invited",
) => ({
  id: invite.inviteId,
  name: invite.name,
  email: invite.email,
  role: invite.role,
  status,
  twoFactor: { setUp: false },
  isYou: false,
});

const transaction = async <T>(
  run: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  try {
    return await mongoose.connection.transaction(run, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 20)
      throw new AppError(
        503,
        "transactions_unavailable",
        "Staff changes require a MongoDB replica set. Check the database configuration.",
      );
    if (
      error instanceof mongoose.mongo.MongoServerError &&
      error.code === 11000
    )
      throw emailTaken();
    throw error;
  }
};

// Writing the acting account serializes its changes and conflicts with concurrent demotion,
// deactivation, logout or reset. Mutual super-admin demotions also write both accounts, so
// one retries and must recheck the actor and last-super-admin rule in a fresh snapshot.
const manager = async (actor: AdminDocument, session: ClientSession) => {
  const current = await AdminModel.findOneAndUpdate(
    {
      _id: actor._id,
      status: "active",
      role: AdminRole.SUPER_ADMIN,
      twoStepEnabled: true,
      sessionVersion: actor.sessionVersion,
    },
    { $inc: { staffChanges: 1 } },
    { new: true, session },
  );
  if (!current) throw staffPermissionError("manage_staff");
  return current;
};
const protectLastSuper = async (
  admin: AdminDocument,
  session: ClientSession,
) => {
  if (
    admin.role === AdminRole.SUPER_ADMIN &&
    admin.status === "active" &&
    (await AdminModel.countDocuments({
      role: AdminRole.SUPER_ADMIN,
      status: "active",
    }).session(session)) <= 1
  )
    throw lastSuperAdmin();
};
const audit = (
  actor: AdminDocument,
  action: string,
  id: string,
  details: string,
  session: ClientSession,
) =>
  recordAudit(
    actor,
    {
      action,
      target: { type: id.startsWith("inv_") ? "staff_invite" : "staff", id },
      details,
    },
    session,
  );
const mailInvite = (email: string, token: string) =>
  sendMail({
    to: email,
    subject: "You’re invited to join HIP staff",
    text: `You’ve been invited to join HIP staff. Set your password using this link:\n${ENV.CLIENT_URL}/staff/invite?token=${token}\n\nThis link expires in 72 hours and can only be used once.`,
  });

export const list = async (actor: AdminDocument) => {
  const [admins, invites] = await Promise.all([
    AdminModel.find(),
    StaffInviteModel.find({ state: "pending" }).sort({ createdAt: 1 }),
  ]);
  const roles = Object.values(AdminRole);
  admins.sort(
    (a, b) =>
      roles.indexOf(a.role) - roles.indexOf(b.role) ||
      a.fullName.localeCompare(b.fullName),
  );
  return [
    ...admins.map((admin) => staffMemberResponse(admin, actor.id)),
    ...invites.map((invite) => inviteResponse(invite)),
  ];
};

export const invite = async (
  actor: AdminDocument,
  body: { name: string; email: string; role: AdminRole },
) => {
  const token = newToken();
  const result = await transaction(async (session) => {
    const current = await manager(actor, session);
    if (
      (await AdminModel.exists({ email: body.email }).session(session)) ||
      (await StaffInviteModel.exists({
        email: body.email,
        state: "pending",
      }).session(session))
    )
      throw emailTaken();
    const [created] = await StaffInviteModel.create(
      [
        {
          ...body,
          inviteId: `inv_${randomUUID()}`,
          tokenHash: hashToken(token),
          expiresAt: expiry(),
        },
      ],
      { session },
    );
    await audit(
      current,
      "staff.invited",
      created.inviteId,
      `Invited ${body.name} (${body.email}) as ${body.role}`,
      session,
    );
    return inviteResponse(created);
  });
  // SMTP runs once, after commit, never inside a transaction callback that MongoDB may retry.
  // If delivery fails, the pending invite remains visible and can be resent or cancelled.
  await mailInvite(body.email, token);
  return result;
};

export const resendInvite = async (actor: AdminDocument, id: string) => {
  const token = newToken();
  const email = await transaction(async (session) => {
    const current = await manager(actor, session);
    const invite = await StaffInviteModel.findOneAndUpdate(
      { inviteId: id, state: "pending" },
      {
        $set: { tokenHash: hashToken(token), expiresAt: expiry() },
      },
      { new: true, session },
    );
    if (!invite) throw missingInvite();
    await audit(
      current,
      "staff.invite_resent",
      id,
      `Invite sent again to ${invite.email}`,
      session,
    );
    return invite.email;
  });
  await mailInvite(email, token);
};

export const changeRole = async (
  actor: AdminDocument,
  id: string,
  role: AdminRole,
) =>
  transaction(async (session) => {
    const current = await manager(actor, session);
    if (id === actor.id)
      throw new AppError(
        403,
        "own_role",
        "You can’t change your own role. Ask another super admin.",
      );
    const invite = await StaffInviteModel.findOne({
      inviteId: id,
      state: "pending",
    }).session(session);
    if (invite) {
      const before = invite.role;
      invite.role = role;
      await invite.save({ session });
      await audit(
        current,
        "staff.role_changed",
        id,
        `${invite.name} (invited): ${before} → ${role}`,
        session,
      );
      return inviteResponse(invite);
    }
    if (id.startsWith("inv_")) throw missingStaff();
    const admin = await AdminModel.findById(id).session(session);
    if (!admin) throw missingStaff();
    if (role !== AdminRole.SUPER_ADMIN) await protectLastSuper(admin, session);
    const before = admin.role;
    admin.role = role;
    await admin.save({ session });
    await audit(
      current,
      "staff.role_changed",
      id,
      `${admin.fullName}: ${before} → ${role}`,
      session,
    );
    return staffMemberResponse(admin, actor.id);
  });

export const setActive = async (
  actor: AdminDocument,
  id: string,
  active: boolean,
) =>
  transaction(async (session) => {
    const current = await manager(actor, session);
    if (id === actor.id)
      throw new AppError(
        403,
        "own_deactivation",
        "You can’t deactivate your own account.",
      );
    const invite = await StaffInviteModel.findOne({
      inviteId: id,
      state: "pending",
    }).session(session);
    if (invite) {
      if (active)
        throw new AppError(
          409,
          "invite_pending",
          "An invite becomes active when the person accepts it.",
        );
      invite.state = "cancelled";
      await invite.save({ session });
      await audit(
        current,
        "staff.invite_cancelled",
        id,
        `Cancelled the invite for ${invite.email}`,
        session,
      );
      return inviteResponse(invite, "deactivated");
    }
    if (id.startsWith("inv_")) throw missingStaff();
    const admin = await AdminModel.findById(id).session(session);
    if (!admin) throw missingStaff();
    if (!active) await protectLastSuper(admin, session);
    admin.status = active ? "active" : "deactivated";
    // Reactivation never resurrects a cookie or challenge issued before deactivation.
    admin.$inc("sessionVersion", 1);
    await admin.save({ session });
    await StaffChallengeModel.deleteMany({ adminId: admin._id }).session(
      session,
    );
    await audit(
      current,
      active ? "staff.activated" : "staff.deactivated",
      id,
      `${active ? "Activated" : "Deactivated"} ${admin.fullName}`,
      session,
    );
    return staffMemberResponse(admin, actor.id);
  });

export const resetTwoStep = async (actor: AdminDocument, id: string) =>
  transaction(async (session) => {
    const current = await manager(actor, session);
    if (id.startsWith("inv_")) throw missingStaff();
    const admin = await AdminModel.findByIdAndUpdate(
      id,
      {
        $set: { twoStepEnabled: false, setupAttempts: 0 },
        $unset: {
          authenticatorSecret: 1,
          twoStepEnabledAt: 1,
          setupExpiresAt: 1,
        },
        $inc: { sessionVersion: 1 },
      },
      { new: true, session },
    );
    if (!admin) throw missingStaff();
    await StaffChallengeModel.deleteMany({ adminId: admin._id }).session(
      session,
    );
    await audit(
      current,
      "staff.two_factor_reset",
      id,
      `Two-step login reset for ${admin.fullName}: they set it up again at their next sign-in`,
      session,
    );
    return staffMemberResponse(admin, actor.id);
  });

export const acceptInvite = async (token: string, password: string) => {
  if (!/^[a-f\d]{64}$/.test(token)) throw invalidInvite();
  const tokenHash = hashToken(token);
  if (
    !(await StaffInviteModel.exists({
      tokenHash,
      state: "pending",
      expiresAt: { $gt: new Date() },
    }))
  )
    throw invalidInvite();
  const passwordHash = await promisify(bcrypt.hash)(password, 12);
  const admin = await transaction(async (session) => {
    const invite = await StaffInviteModel.findOneAndUpdate(
      { tokenHash, state: "pending", expiresAt: { $gt: new Date() } },
      {
        $set: { state: "accepted" },
      },
      { new: true, session },
    );
    if (!invite) throw invalidInvite();
    if (await AdminModel.exists({ email: invite.email }).session(session))
      throw emailTaken();
    const [created] = await AdminModel.create(
      [
        {
          fullName: invite.name,
          email: invite.email,
          role: invite.role,
          passwordHash,
          status: "active",
          twoStepEnabled: false,
          lastActiveAt: new Date(),
        },
      ],
      { session },
    );
    await audit(
      created,
      "staff.invite_accepted",
      created.id,
      `Accepted the staff invite for ${invite.email}`,
      session,
    );
    return created;
  });
  return {
    data: toStaffResponse(admin),
    session: createStaffSession(admin, "setup"),
  };
};
