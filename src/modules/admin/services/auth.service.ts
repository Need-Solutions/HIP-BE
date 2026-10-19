import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import bcrypt from "bcrypt";
import { promisify } from "util";
import {
  AdminModel,
  toStaffResponse,
  type AdminDocument,
} from "../../../database/models/admin.schema";
import { StaffChallengeModel } from "../../../database/models/staff-challenge.schema";
import { AppError } from "../../../shared/errors/app.error";
import {
  assertUnlocked,
  clearLoginFailures,
  failLogin,
  loginKey,
} from "../../users/services/login-attempt.service";
import {
  CODE_ATTEMPTS,
  CODE_TTL_MS,
  RESEND_SECONDS,
  deliverCode,
  generateCode,
  hashCode,
} from "../../users/services/verification-code.service";
import { authenticatorCodeValid } from "./authenticator.service";
import { createStaffSession } from "./auth-session.service";

const comparePassword = promisify(bcrypt.compare);
const dummyHash = promisify(bcrypt.hash)(randomBytes(32).toString("hex"), 12);
const expired = () =>
  new AppError(
    410,
    "code_expired",
    "Your sign-in timed out. Please sign in again.",
  );
const deactivated = () =>
  new AppError(
    403,
    "suspended",
    "This staff account is deactivated. Ask a super admin.",
  );
const challengeResponse = (
  challenge: { challengeId: string; method: "email" | "authenticator" },
  admin: AdminDocument,
) => ({
  challengeId: challenge.challengeId,
  method: challenge.method,
  ...(challenge.method === "email"
    ? { destination: admin.email.replace(/^(.)[^@]*(@.*)$/, "$1•••••$2") }
    : {}),
});
const rateLimited = (until: Date) =>
  new AppError(
    429,
    "rate_limited",
    "Please wait a moment before asking for another code.",
    {
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((until.getTime() - Date.now()) / 1000),
      ),
    },
  );

const startChallenge = async (
  admin: AdminDocument,
): Promise<ReturnType<typeof challengeResponse>> => {
  const current = await StaffChallengeModel.findOne({ adminId: admin._id });
  const method = admin.twoStepEnabled ? "authenticator" : "email";
  const now = new Date();
  if (
    current &&
    current.expiresAt > now &&
    current.sessionVersion === admin.sessionVersion &&
    current.method === method
  ) {
    if (current.attempts < CODE_ATTEMPTS)
      return challengeResponse(current, admin);
    if (method === "email" && current.resendAvailableAt > now)
      throw rateLimited(current.resendAvailableAt);
  }
  const challengeId = `stf_${randomUUID()}`;
  const code = method === "email" ? generateCode() : undefined;
  const fields = {
    adminId: admin._id,
    challengeId,
    method,
    codeHash: code ? hashCode(challengeId, code) : undefined,
    attempts: 0,
    sessionVersion: admin.sessionVersion,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
    resendAvailableAt: new Date(Date.now() + RESEND_SECONDS * 1000),
  };
  let saved;
  try {
    saved = current
      ? await StaffChallengeModel.findOneAndUpdate(
          {
            _id: current._id,
            challengeId: current.challengeId,
            attempts: current.attempts,
            expiresAt: current.expiresAt,
          },
          { $set: fields },
          { new: true },
        )
      : await StaffChallengeModel.create(fields);
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === 11000))
      throw err;
  }
  if (!saved) return startChallenge(admin); // Another login won the claim; reuse its challenge and cooldown.
  if (code) {
    try {
      await deliverCode(admin.email, "email", code);
    } catch (err) {
      await StaffChallengeModel.deleteOne({ challengeId });
      throw err;
    }
  }
  return challengeResponse(saved, admin);
};

export const login = async (email: string, password: string) => {
  const key = `staff:${loginKey(email)}`; // Hiker keys are plain digests, so the namespaces cannot collide.
  await assertUnlocked(key);
  const admin = await AdminModel.findOne({ email }).select(
    "+passwordHash +sessionVersion",
  );
  const matches = await comparePassword(
    password,
    admin?.passwordHash ?? (await dummyHash),
  );
  if (!admin || !matches || Buffer.byteLength(password, "utf8") > 72)
    return failLogin(key);
  await assertUnlocked(key);
  await clearLoginFailures(key);
  if (admin.status !== "active") throw deactivated();
  return startChallenge(admin);
};

const challengeAdmin = async (challenge: {
  adminId: unknown;
  sessionVersion: number;
  method: string;
}) => {
  const admin = await AdminModel.findById(challenge.adminId).select(
    "+sessionVersion +authenticatorSecret",
  );
  if (
    !admin ||
    admin.status !== "active" ||
    admin.sessionVersion !== challenge.sessionVersion ||
    admin.twoStepEnabled !== (challenge.method === "authenticator")
  )
    throw expired();
  return admin;
};

export const verify = async (challengeId: string, code: string) => {
  const challenge = await StaffChallengeModel.findOneAndUpdate(
    {
      challengeId,
      expiresAt: { $gt: new Date() },
      attempts: { $lt: CODE_ATTEMPTS },
    },
    { $inc: { attempts: 1 } },
    { new: true },
  ).select("+codeHash");
  if (!challenge) throw expired();
  const admin = await challengeAdmin(challenge);
  const valid =
    challenge.method === "authenticator"
      ? !!admin.authenticatorSecret &&
        (await authenticatorCodeValid(admin.authenticatorSecret, code))
      : timingSafeEqual(
          Buffer.from(challenge.codeHash!, "hex"),
          Buffer.from(hashCode(challengeId, code), "hex"),
        );
  if (!valid) {
    if (challenge.attempts >= CODE_ATTEMPTS) throw expired();
    throw new AppError(
      400,
      "invalid_code",
      challenge.method === "authenticator"
        ? "That code isn’t right. Check your authenticator app."
        : "That code isn’t right.",
      { attemptsLeft: CODE_ATTEMPTS - challenge.attempts },
    );
  }
  const consumed = await StaffChallengeModel.findOneAndDelete({
    _id: challenge._id,
    challengeId,
    expiresAt: { $gt: new Date() },
    ...(challenge.method === "email" ? { codeHash: challenge.codeHash } : {}),
  });
  if (!consumed) throw expired();
  return {
    data: toStaffResponse(admin),
    session: createStaffSession(admin, admin.twoStepEnabled ? "full" : "setup"),
  };
};

export const resend = async (challengeId: string) => {
  const current = await StaffChallengeModel.findOne({
    challengeId,
    expiresAt: { $gt: new Date() },
    attempts: { $lt: CODE_ATTEMPTS },
  }).select("+codeHash");
  if (!current) throw expired();
  const admin = await challengeAdmin(current);
  if (current.method !== "email")
    throw new AppError(
      403,
      "authenticator_required",
      "Use the code from your authenticator app.",
    );
  if (current.resendAvailableAt > new Date())
    throw rateLimited(current.resendAvailableAt);
  const code = generateCode();
  const codeHash = hashCode(challengeId, code);
  const updated = await StaffChallengeModel.findOneAndUpdate(
    {
      _id: current._id,
      codeHash: current.codeHash,
      expiresAt: { $gt: new Date() },
      attempts: { $lt: CODE_ATTEMPTS },
      resendAvailableAt: { $lte: new Date() },
    },
    {
      $set: {
        codeHash,
        attempts: 0,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
        resendAvailableAt: new Date(Date.now() + RESEND_SECONDS * 1000),
      },
    },
    { new: true },
  );
  if (!updated) {
    const latest = await StaffChallengeModel.findById(current._id);
    if (!latest) throw expired();
    throw rateLimited(latest.resendAvailableAt);
  }
  try {
    await deliverCode(admin.email, "email", code);
  } catch (err) {
    await StaffChallengeModel.updateOne(
      { _id: current._id, codeHash },
      {
        $set: {
          codeHash: current.codeHash,
          attempts: current.attempts,
          expiresAt: current.expiresAt,
          resendAvailableAt: current.resendAvailableAt,
        },
      },
    );
    throw err;
  }
  return challengeResponse(updated, admin);
};

// TODO(Controller 4): super-admin-only reset of another staff member's two-step setup,
// with session/challenge revocation. There is deliberately no email fallback for enrolled staff.
