import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import bcrypt from "bcrypt";
import { promisify } from "util";
import { ENV } from "../../../config/env";
import { PasswordResetModel } from "../../../database/models/password-reset.schema";
import {
  UserModel,
  toUserResponse,
  type UserDocument,
} from "../../../database/models/users.schema";
import { VerificationCodeModel } from "../../../database/models/verification-code.schema";
import { sendMail } from "../../../services/mail.service";
import { AppError } from "../../../shared/errors/app.error";
import { createSession } from "./auth-session.service";
import {
  assertUnlocked,
  clearLoginFailures,
  failLogin,
  loginKey,
} from "./login-attempt.service";
import {
  normalisePhone,
  type SignupRequest,
} from "../validators/auth.validator";

import {
  CODE_ATTEMPTS,
  RESEND_SECONDS,
  CODE_TTL_MS,
  generateCode,
  hashCode,
  deliverCode,
} from "./verification-code.service";

const HASH_ROUNDS = 12;
const RESET_TTL_MS = 30 * 60 * 1000;
const hashPassword = promisify(bcrypt.hash);
const comparePassword = promisify(bcrypt.compare);
const dummyHash = hashPassword(randomBytes(32).toString("hex"), HASH_ROUNDS);
type Channel = "email" | "phone";

const maskEmail = (email: string) =>
  email.replace(/^(.)[^@]*(@.*)$/, "$1•••••$2");
const maskPhone = (phone: string) =>
  `${phone.slice(0, 4)} ••• ••• ${phone.slice(-4)}`;
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const expiredCode = (message = "This code has expired. Request a new one.") =>
  new AppError(410, "code_expired", message);
const invalidToken = () =>
  new AppError(
    400,
    "token_invalid",
    "This reset link has expired or was already used.",
  );

const codeFields = (channel: Channel) => {
  const code = generateCode();
  const verificationId = `ver_${randomUUID()}`;
  return {
    code,
    fields: {
      verificationId,
      channel,
      codeHash: hashCode(verificationId, code),
      attempts: 0,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      resendAvailableAt: new Date(Date.now() + RESEND_SECONDS * 1000),
    },
  };
};

const verificationResponse = (
  verification: {
    verificationId: string;
    channel: Channel;
    resendAvailableAt: Date;
  },
  user: UserDocument,
) => ({
  verificationId: verification.verificationId,
  channel: verification.channel,
  destination:
    verification.channel === "email"
      ? maskEmail(user.email)
      : maskPhone(user.phone),
  resendAvailableAt: verification.resendAvailableAt.toISOString(),
  // TODO(TKT): count guest tickets matching the holder's email/phone once tickets exist.
  guestTicketsToMerge: 0,
});

const startVerification = async (user: UserDocument) => {
  const existing = await VerificationCodeModel.findOne({
    userId: user._id,
    expiresAt: { $gt: new Date() },
  });
  if (existing && existing.resendAvailableAt.getTime() > Date.now()) {
    return verificationResponse(existing, user);
  }
  const { code, fields } = codeFields("email");
  const verification = await VerificationCodeModel.findOneAndUpdate(
    { userId: user._id },
    { $set: fields },
    { upsert: true, new: true },
  );
  await deliverCode(user.email, "email", code);
  return verificationResponse(verification, user);
};

export const signup = async (request: SignupRequest) => {
  // AUTH-004: only finished accounts reserve both contact fields.
  const [emailTaken, phoneTaken] = await Promise.all([
    UserModel.exists({ email: request.email, status: { $ne: "unverified" } }),
    UserModel.exists({ phone: request.phone, status: { $ne: "unverified" } }),
  ]);
  if (emailTaken) {
    throw new AppError(
      409,
      "email_taken",
      "An account with this email already exists.",
      { field: "email" },
    );
  }
  if (phoneTaken) {
    throw new AppError(
      409,
      "phone_taken",
      "An account with this phone number already exists.",
      { field: "phone" },
    );
  }
  const passwordHash = await hashPassword(request.password, HASH_ROUNDS);
  // Replace the unfinished signup's details. Its old code must stop working.
  const user = await UserModel.findOneAndUpdate(
    { email: request.email, status: "unverified" },
    {
      $set: {
        fullName: request.fullName,
        email: request.email,
        phone: request.phone,
        passwordHash,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
  await VerificationCodeModel.deleteMany({ userId: user._id });
  return startVerification(user);
};

export const resend = async (verificationId: string, channel: Channel) => {
  const old = await VerificationCodeModel.findOne({
    verificationId,
    expiresAt: { $gt: new Date() },
  });
  const user =
    old &&
    (await UserModel.findOne({
      _id: old.userId,
      status: { $in: ["unverified", "active"] },
    }));
  if (!old || !user) {
    throw expiredCode("This code has expired. Please sign up or log in again.");
  }
  const retryAfterSeconds = Math.ceil(
    (old.resendAvailableAt.getTime() - Date.now()) / 1000,
  );
  if (retryAfterSeconds > 0) {
    throw new AppError(
      429,
      "rate_limited",
      `Please wait ${retryAfterSeconds} seconds before requesting another code.`,
      { retryAfterSeconds },
    );
  }
  if (channel === "phone" && ENV.NODE_ENV !== "development") {
    throw new AppError(
      503,
      "sms_unavailable",
      "Phone verification is not available yet. Please use email.",
    );
  }
  const { code, fields } = codeFields(channel);
  // Rotate atomically: only one concurrent resend may use the old ID.
  const verification = await VerificationCodeModel.findOneAndUpdate(
    {
      verificationId,
      resendAvailableAt: { $lte: new Date() },
      expiresAt: { $gt: new Date() },
    },
    { $set: fields },
    { new: true },
  );
  if (!verification) {
    throw expiredCode("This code has expired. Please sign up or log in again.");
  }
  await deliverCode(
    channel === "email" ? user.email : user.phone,
    channel,
    code,
  );
  return verificationResponse(verification, user);
};

export const verify = async (verificationId: string, code: string) => {
  // Reserve a try atomically so parallel requests cannot bypass the five-try limit.
  const verification = await VerificationCodeModel.findOneAndUpdate(
    {
      verificationId,
      attempts: { $lt: CODE_ATTEMPTS },
      expiresAt: { $gt: new Date() },
    },
    { $inc: { attempts: 1 } },
    { new: true },
  ).select("+codeHash");
  if (!verification) {
    throw expiredCode();
  }
  const correct = timingSafeEqual(
    Buffer.from(hashCode(verificationId, code), "hex"),
    Buffer.from(verification.codeHash, "hex"),
  );
  if (!correct) {
    if (verification.attempts >= CODE_ATTEMPTS) {
      await VerificationCodeModel.deleteOne({ verificationId });
      throw expiredCode("Too many wrong codes. Request a new one.");
    }
    throw new AppError(400, "invalid_code", "That code isn’t right.", {
      attemptsLeft: CODE_ATTEMPTS - verification.attempts,
    });
  }
  const consumed = await VerificationCodeModel.findOneAndDelete({
    verificationId,
    codeHash: verification.codeHash,
    expiresAt: { $gt: new Date() },
  });
  if (!consumed) {
    throw expiredCode();
  }
  const user = await UserModel.findOneAndUpdate(
    { _id: verification.userId, status: { $in: ["unverified", "active"] } },
    {
      $set: {
        status: "active",
        [verification.channel === "email" ? "emailVerified" : "phoneVerified"]:
          true,
      },
    },
    { new: true, runValidators: true },
  ).select("+sessionVersion");
  if (!user) {
    throw expiredCode();
  }
  // TODO(TKT): link guest tickets/history by holder email/phone after verification.
  return {
    data: { user: toUserResponse(user), mergedTickets: 0 },
    session: createSession(user),
  };
};

export const login = async (
  identifier: string,
  password: string,
  remember: boolean,
) => {
  const key = loginKey(identifier);
  await assertUnlocked(key);
  const user = await UserModel.findOne({
    $or: [
      { email: identifier.trim().toLowerCase() },
      { phone: normalisePhone(identifier.trim()) },
    ],
  }).select("+passwordHash +sessionVersion");
  // AUTH-009: do the same expensive comparison for an unknown identifier.
  const matches = await comparePassword(
    password,
    user?.passwordHash ?? (await dummyHash),
  );
  if (!user || !matches || Buffer.byteLength(password, "utf8") > 72) {
    return failLogin(key);
  }
  await assertUnlocked(key);
  await clearLoginFailures(key);
  if (user.status === "suspended" || user.status === "deactivated") {
    throw new AppError(
      403,
      "suspended",
      "This account is suspended. Contact the group if you think this is a mistake.",
    );
  }
  if (user.status === "unverified") {
    const verification = await startVerification(user);
    throw new AppError(
      403,
      "unverified",
      "Please verify your email to finish setting up your account.",
      {
        verificationId: verification.verificationId,
        destination: verification.destination,
      },
    );
  }
  return { data: toUserResponse(user), session: createSession(user, remember) };
};

export const forgot = async (email: string) => {
  // AUTH-010: nonexistent accounts and mail delivery failures get the same 204.
  const user = await UserModel.findOne({ email });
  if (!user) {
    return;
  }
  const token = randomBytes(32).toString("hex");
  await PasswordResetModel.findOneAndUpdate(
    { userId: user._id },
    {
      $set: {
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
        usedAt: null,
      },
    },
    { upsert: true },
  );
  const url = new URL("/reset-password", ENV.CLIENT_URL);
  url.searchParams.set("token", token);
  try {
    await sendMail({
      to: user.email,
      subject: "Reset your HIP password",
      text: `Reset your password: ${url.toString()}\nThis link works once and expires in 30 minutes.`,
    });
  } catch {
    // The mail service logs only a generic delivery failure, never the token.
  }
};

export const reset = async (token: string, password: string) => {
  const tokenHash = hashToken(token);
  const resetToken = await PasswordResetModel.findOne({
    tokenHash,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  });
  const user =
    resetToken &&
    (await UserModel.findById(resetToken.userId).select("+passwordHash"));
  if (!resetToken || !user) {
    throw invalidToken();
  }
  if (await comparePassword(password, user.passwordHash)) {
    throw new AppError(
      400,
      "password_reused",
      "Choose a password you haven’t used on HIP before.",
      { field: "password" },
    );
  }
  const passwordHash = await hashPassword(password, HASH_ROUNDS);
  const consumed = await PasswordResetModel.findOneAndUpdate(
    {
      _id: resetToken._id,
      tokenHash,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
  );
  if (!consumed) {
    throw invalidToken();
  }
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { passwordHash }, $inc: { sessionVersion: 1 } },
  );
  await Promise.all([
    clearLoginFailures(loginKey(user.email)),
    clearLoginFailures(loginKey(user.phone)),
  ]);
};
