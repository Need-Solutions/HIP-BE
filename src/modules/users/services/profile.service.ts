import { randomUUID, timingSafeEqual } from "crypto";
import { mongo } from "mongoose";
import { ContactChangeModel } from "../../../database/models/contact-change.schema";
import {
  UserModel,
  toUserResponse,
  defaultNotifications,
  type UserDocument,
} from "../../../database/models/users.schema";
import { VerificationCodeModel } from "../../../database/models/verification-code.schema";
import { PasswordResetModel } from "../../../database/models/password-reset.schema";
import { AppError } from "../../../shared/errors/app.error";
import type {
  ProfileUpdate,
  NotificationUpdate,
} from "../validators/profile.validator";
import {
  CODE_ATTEMPTS,
  CODE_TTL_MS,
  RESEND_SECONDS,
  assertCodeDelivery,
  deliverCode,
  generateCode,
  hashCode,
} from "./verification-code.service";

type ContactField = "email" | "phone";

const expired = (
  message = "This code has expired. Save your details again to get a new one.",
) => new AppError(410, "code_expired", message);

const contactTaken = (field: ContactField) =>
  new AppError(
    409,
    `${field}_taken`,
    `Another account already uses this ${field === "email" ? "email" : "phone number"}.`,
    { field },
  );

const getUser = async (userId: string) => {
  const user = await UserModel.findOne({
    _id: userId,
    status: "active",
    roles: "hiker",
  });
  if (!user)
    throw new AppError(401, "unauthenticated", "Please log in to continue.");
  return user;
};

const notifications = (user: UserDocument) => ({
  ticketConfirmations: true as const,
  reminders: user.notifications?.reminders ?? defaultNotifications.reminders,
  reminderChannel:
    user.notifications?.reminderChannel ?? defaultNotifications.reminderChannel,
  promotions: user.notifications?.promotions ?? false,
});

const toProfile = async (user: UserDocument) => {
  const pending = await ContactChangeModel.find({
    userId: user._id,
    expiresAt: { $gt: new Date() },
    attempts: { $lt: CODE_ATTEMPTS },
  }).sort({ createdAt: 1 });
  return {
    user: toUserResponse(user),
    ...(user.dateOfBirth ? { dateOfBirth: user.dateOfBirth } : {}),
    ...(user.emergencyContact
      ? {
          emergencyContact: {
            name: user.emergencyContact.name,
            phone: user.emergencyContact.phone,
          },
        }
      : {}),
    // TODO(ATT): count check-ins when the attendance controller exists. Never count ticket sales.
    hikesAttended: 0,
    notifications: notifications(user),
    pendingContacts: pending.map((change) => ({
      verificationId: change.verificationId,
      field: change.field,
      value: change.value,
      resendAvailableAt: change.resendAvailableAt.toISOString(),
    })),
  };
};

const assertAvailable = async (
  field: ContactField,
  value: string,
  userId: string,
) => {
  if (
    await UserModel.exists({
      _id: { $ne: userId },
      [field]: value,
      status: { $ne: "unverified" },
    })
  )
    throw contactTaken(field);
};

const assertEmergencyPhone = (
  emergencyPhone: string | undefined,
  ownPhone: string,
) => {
  if (emergencyPhone && emergencyPhone === ownPhone)
    throw new AppError(
      400,
      "validation_error",
      "Use someone else’s number, not your own",
      { field: "emergencyContact.phone" },
    );
};

export const getProfile = async (userId: string) =>
  toProfile(await getUser(userId));

export const updateProfile = async (userId: string, request: ProfileUpdate) => {
  const user = await getUser(userId);
  assertEmergencyPhone(request.emergencyContact?.phone, user.phone);
  const pending = await ContactChangeModel.find({
    userId,
    expiresAt: { $gt: new Date() },
  });
  const changes = [];
  for (const field of ["email", "phone"] as const) {
    if (request[field] === user[field]) continue;
    await assertAvailable(field, request[field], userId);
    const existing = pending.find(
      (change) => change.field === field && change.value === request[field],
    );
    if (existing) continue; // Saving the same pending value must not reset attempts or bypass the cooldown.
    assertCodeDelivery(field);
    const code = generateCode();
    const verificationId = `cv_${randomUUID()}`;
    changes.push({
      field,
      value: request[field],
      verificationId,
      code,
      codeHash: hashCode(verificationId, code),
    });
  }
  // Check both destinations before sending anything; a failed email does not change the profile.
  for (const change of changes)
    await deliverCode(change.value, change.field, change.code);
  for (const change of changes) {
    await ContactChangeModel.findOneAndUpdate(
      { userId, field: change.field },
      {
        $set: {
          verificationId: change.verificationId,
          value: change.value,
          codeHash: change.codeHash,
          attempts: 0,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
          resendAvailableAt: new Date(Date.now() + RESEND_SECONDS * 1000),
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
  }
  for (const field of ["email", "phone"] as const) {
    if (request[field] === user[field])
      await ContactChangeModel.deleteMany({ userId, field });
  }
  const updated = await UserModel.findOneAndUpdate(
    { _id: userId, status: "active", roles: "hiker" },
    {
      $set: {
        fullName: request.fullName,
        ...(request.dateOfBirth ? { dateOfBirth: request.dateOfBirth } : {}),
        ...(request.emergencyContact
          ? { emergencyContact: request.emergencyContact }
          : {}),
      },
      $unset: {
        ...(!request.dateOfBirth ? { dateOfBirth: 1 } : {}),
        ...(!request.emergencyContact ? { emergencyContact: 1 } : {}),
      },
    },
    { new: true, runValidators: true },
  );
  if (!updated)
    throw new AppError(401, "unauthenticated", "Please log in to continue.");
  return toProfile(updated);
};

export const confirmContact = async (
  userId: string,
  verificationId: string,
  code: string,
) => {
  const user = await getUser(userId);
  const pending = await ContactChangeModel.findOneAndUpdate(
    {
      userId,
      verificationId,
      attempts: { $lt: CODE_ATTEMPTS },
      expiresAt: { $gt: new Date() },
    },
    { $inc: { attempts: 1 } },
    { new: true },
  ).select("+codeHash");
  if (!pending) throw expired();
  if (
    !timingSafeEqual(
      Buffer.from(hashCode(verificationId, code), "hex"),
      Buffer.from(pending.codeHash, "hex"),
    )
  ) {
    if (pending.attempts >= CODE_ATTEMPTS) {
      await ContactChangeModel.deleteOne({
        _id: pending._id,
        verificationId,
        codeHash: pending.codeHash,
      });
      throw expired(
        "Too many wrong codes. Save your details again to get a new code.",
      );
    }
    throw new AppError(400, "invalid_code", "That code isn’t right.", {
      attemptsLeft: CODE_ATTEMPTS - pending.attempts,
    });
  }
  await assertAvailable(pending.field, pending.value, userId);
  if (pending.field === "phone")
    assertEmergencyPhone(user.emergencyContact?.phone, pending.value);
  const consumed = await ContactChangeModel.findOneAndDelete({
    _id: pending._id,
    userId,
    verificationId,
    codeHash: pending.codeHash,
    expiresAt: { $gt: new Date() },
  });
  if (!consumed) throw expired();
  if (pending.field === "email") {
    // Proof of the new email takes precedence over an unfinished signup occupying it.
    const unfinished = await UserModel.findOneAndDelete({
      _id: { $ne: userId },
      email: pending.value,
      status: "unverified",
    });
    if (unfinished)
      await Promise.all([
        VerificationCodeModel.deleteMany({ userId: unfinished._id }),
        PasswordResetModel.deleteMany({ userId: unfinished._id }),
      ]);
  }
  try {
    const updated = await UserModel.findOneAndUpdate(
      { _id: userId, status: "active", roles: "hiker" },
      {
        $set: {
          [pending.field]: pending.value,
          [pending.field === "email" ? "emailVerified" : "phoneVerified"]: true,
        },
      },
      { new: true, runValidators: true },
    );
    if (!updated)
      throw new AppError(401, "unauthenticated", "Please log in to continue.");
    if (pending.field === "email")
      await PasswordResetModel.deleteMany({ userId });
    return toProfile(updated);
  } catch (error) {
    if (error instanceof mongo.MongoServerError && error.code === 11000)
      throw contactTaken(pending.field);
    throw error;
  }
};

export const resendContactCode = async (
  userId: string,
  verificationId: string,
) => {
  const user = await getUser(userId);
  const pending = await ContactChangeModel.findOne({
    userId,
    verificationId,
    expiresAt: { $gt: new Date() },
    attempts: { $lt: CODE_ATTEMPTS },
  });
  if (!pending)
    throw expired("This change has expired. Save your details again.");
  const retryAfterSeconds = Math.ceil(
    (pending.resendAvailableAt.getTime() - Date.now()) / 1000,
  );
  if (retryAfterSeconds > 0)
    throw new AppError(
      429,
      "rate_limited",
      "Please wait a moment before asking for another code.",
      { retryAfterSeconds },
    );
  await assertAvailable(pending.field, pending.value, userId);
  assertCodeDelivery(pending.field);
  const code = generateCode();
  const claimed = await ContactChangeModel.findOneAndUpdate(
    {
      _id: pending._id,
      userId,
      verificationId,
      expiresAt: { $gt: new Date() },
      resendAvailableAt: { $lte: new Date() },
      attempts: { $lt: CODE_ATTEMPTS },
    },
    {
      $set: {
        codeHash: hashCode(verificationId, code),
        attempts: 0,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
        resendAvailableAt: new Date(Date.now() + RESEND_SECONDS * 1000),
      },
    },
    { new: true },
  );
  if (!claimed)
    throw new AppError(
      429,
      "rate_limited",
      "Please wait a moment before asking for another code.",
      { retryAfterSeconds: RESEND_SECONDS },
    );
  await deliverCode(pending.value, pending.field, code);
  return toProfile(user);
};

export const cancelContactChange = async (
  userId: string,
  verificationId: string,
) => {
  const user = await getUser(userId);
  await ContactChangeModel.deleteOne({ userId, verificationId });
  return toProfile(user);
};

export const getNotifications = async (userId: string) =>
  notifications(await getUser(userId));

export const updateNotifications = async (
  userId: string,
  prefs: NotificationUpdate,
) => {
  const user = await UserModel.findOneAndUpdate(
    { _id: userId, status: "active", roles: "hiker" },
    { $set: { notifications: { ...prefs, ticketConfirmations: true } } },
    { new: true, runValidators: true },
  );
  if (!user)
    throw new AppError(401, "unauthenticated", "Please log in to continue.");
  return notifications(user);
};
