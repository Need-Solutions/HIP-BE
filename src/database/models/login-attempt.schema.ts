import mongoose, { Schema } from "mongoose";

interface LoginAttempt {
  key: string;
  count: number;
  lockedUntil: Date | null;
  expiresAt: Date;
}

const schema = new Schema<LoginAttempt>({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  expiresAt: { type: Date, required: true, expires: 0 },
});

export const LoginAttemptModel = mongoose.model<LoginAttempt>(
  "LoginAttempt",
  schema,
);
