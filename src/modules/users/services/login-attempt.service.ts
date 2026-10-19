import { createHmac } from "crypto";
import { ENV } from "../../../config/env";
import { LoginAttemptModel } from "../../../database/models/login-attempt.schema";
import { AppError } from "../../../shared/errors/app.error";
import { normalisePhone } from "../validators/auth.validator";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const MINUTE_MS = 60 * 1000;
const FAILURE_TTL_MS = 24 * 60 * MINUTE_MS;

export const loginKey = (identifier: string) => {
  const value = identifier.includes("@")
    ? identifier.trim().toLowerCase()
    : normalisePhone(identifier.trim());
  return createHmac("sha256", ENV.JWT_SECRET).update(value).digest("hex");
};

const lockedError = (until: Date) => {
  const minutes = Math.max(
    1,
    Math.ceil((until.getTime() - Date.now()) / MINUTE_MS),
  );
  return new AppError(
    423,
    "locked",
    `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    {
      retryAfterSeconds: minutes * 60,
      lockMinutes: LOCK_MINUTES,
    },
  );
};

export const assertUnlocked = async (key: string) => {
  const now = new Date();
  await LoginAttemptModel.deleteOne({
    key,
    $or: [{ lockedUntil: { $lte: now } }, { expiresAt: { $lte: now } }],
  });
  const failure = await LoginAttemptModel.findOne({ key });
  if (failure?.lockedUntil && failure.lockedUntil > now) {
    throw lockedError(failure.lockedUntil);
  }
};

export const failLogin = async (key: string): Promise<never> => {
  const failure = await LoginAttemptModel.findOneAndUpdate(
    { key },
    {
      $inc: { count: 1 },
      $set: { expiresAt: new Date(Date.now() + FAILURE_TTL_MS) },
    },
    { upsert: true, new: true },
  );
  if (failure.count >= MAX_ATTEMPTS) {
    const until = new Date(Date.now() + LOCK_MINUTES * MINUTE_MS);
    await LoginAttemptModel.updateOne(
      { key, lockedUntil: null },
      { $set: { lockedUntil: until } },
    );
    throw lockedError(failure.lockedUntil ?? until);
  }
  throw new AppError(
    401,
    "invalid_credentials",
    "Incorrect email or password.",
    {
      attemptsLeft: MAX_ATTEMPTS - failure.count,
      lockMinutes: LOCK_MINUTES,
    },
  );
};

export const clearLoginFailures = async (key: string) => {
  await LoginAttemptModel.deleteOne({ key });
};
