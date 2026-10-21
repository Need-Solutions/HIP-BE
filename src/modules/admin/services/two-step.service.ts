import {
  AdminModel,
  toStaffResponse,
  type AdminDocument,
} from "../../../database/models/admin.schema";
import { StaffChallengeModel } from "../../../database/models/staff-challenge.schema";
import { AppError } from "../../../shared/errors/app.error";
import {
  CODE_ATTEMPTS,
  CODE_TTL_MS,
} from "../../users/services/verification-code.service";
import {
  authenticatorCodeValid,
  authenticatorSetupResponse,
  encryptSecret,
  newAuthenticatorSecret,
} from "./authenticator.service";
import { createStaffSession } from "./auth-session.service";

const alreadyEnabled = () =>
  new AppError(
    409,
    "two_step_enabled",
    "Your authenticator is already enabled. Please sign in again.",
  );
const setupExpired = () =>
  new AppError(
    410,
    "code_expired",
    "Authenticator setup expired. Start setup again.",
  );

export const setup = async (sessionAdmin: AdminDocument) => {
  let admin = await AdminModel.findOne({
    _id: sessionAdmin._id,
    status: "active",
    sessionVersion: sessionAdmin.sessionVersion,
  }).select(
    "+authenticatorSecret +setupExpiresAt +setupAttempts +sessionVersion",
  );
  if (!admin || admin.twoStepEnabled) throw alreadyEnabled();
  const now = new Date();
  if (
    !admin.authenticatorSecret ||
    !admin.setupExpiresAt ||
    admin.setupExpiresAt <= now ||
    admin.setupAttempts >= CODE_ATTEMPTS
  ) {
    await AdminModel.updateOne(
      {
        _id: admin._id,
        status: "active",
        twoStepEnabled: false,
        sessionVersion: sessionAdmin.sessionVersion,
        $or: [
          { authenticatorSecret: { $exists: false } },
          { setupExpiresAt: { $exists: false } },
          { setupExpiresAt: { $lte: now } },
          { setupAttempts: { $gte: CODE_ATTEMPTS } },
        ],
      },
      {
        $set: {
          authenticatorSecret: encryptSecret(newAuthenticatorSecret()),
          setupExpiresAt: new Date(Date.now() + CODE_TTL_MS),
          setupAttempts: 0,
        },
      },
    );
    admin = await AdminModel.findOne({
      _id: admin._id,
      status: "active",
      sessionVersion: sessionAdmin.sessionVersion,
    }).select(
      "+authenticatorSecret +setupExpiresAt +setupAttempts +sessionVersion",
    );
  }
  if (!admin || admin.twoStepEnabled || !admin.authenticatorSecret)
    throw alreadyEnabled();
  return authenticatorSetupResponse(admin.authenticatorSecret, admin.email);
};

export const enable = async (sessionAdmin: AdminDocument, code: string) => {
  const admin = await AdminModel.findOneAndUpdate(
    {
      _id: sessionAdmin._id,
      status: "active",
      twoStepEnabled: false,
      sessionVersion: sessionAdmin.sessionVersion,
      setupExpiresAt: { $gt: new Date() },
      setupAttempts: { $lt: CODE_ATTEMPTS },
    },
    { $inc: { setupAttempts: 1 } },
    { new: true },
  ).select("+authenticatorSecret +sessionVersion +setupAttempts");
  if (!admin?.authenticatorSecret) throw setupExpired();
  if (!(await authenticatorCodeValid(admin.authenticatorSecret, code))) {
    if (admin.setupAttempts >= CODE_ATTEMPTS) throw setupExpired();
    throw new AppError(
      400,
      "invalid_code",
      "That code isn’t right. Check your authenticator app.",
      { attemptsLeft: CODE_ATTEMPTS - admin.setupAttempts },
    );
  }
  const enabled = await AdminModel.findOneAndUpdate(
    {
      _id: admin._id,
      status: "active",
      twoStepEnabled: false,
      sessionVersion: sessionAdmin.sessionVersion,
      authenticatorSecret: admin.authenticatorSecret,
      setupExpiresAt: { $gt: new Date() },
    },
    {
      $set: {
        twoStepEnabled: true,
        twoStepEnabledAt: new Date(),
        lastActiveAt: new Date(),
      },
      $inc: { sessionVersion: 1 },
      $unset: { setupExpiresAt: 1, setupAttempts: 1 },
    },
    { new: true },
  ).select("+sessionVersion");
  if (!enabled) throw alreadyEnabled();
  await StaffChallengeModel.deleteMany({ adminId: admin._id });
  return {
    data: toStaffResponse(enabled),
    session: createStaffSession(enabled, "full"),
  };
};
