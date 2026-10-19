import mongoose, { Schema } from "mongoose";

interface StaffChallenge {
  adminId: mongoose.Types.ObjectId;
  challengeId: string;
  method: "email" | "authenticator";
  codeHash?: string;
  attempts: number;
  sessionVersion: number;
  expiresAt: Date;
  resendAvailableAt: Date;
}

const schema = new Schema<StaffChallenge>({
  adminId: {
    type: Schema.Types.ObjectId,
    ref: "Admin",
    required: true,
    unique: true,
  },
  challengeId: { type: String, required: true, unique: true },
  method: { type: String, enum: ["email", "authenticator"], required: true },
  codeHash: { type: String, select: false },
  attempts: { type: Number, default: 0 },
  sessionVersion: { type: Number, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
  resendAvailableAt: { type: Date, required: true },
});

export const StaffChallengeModel = mongoose.model<StaffChallenge>(
  "StaffChallenge",
  schema,
);
