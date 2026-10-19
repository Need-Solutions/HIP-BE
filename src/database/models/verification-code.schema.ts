import mongoose, { Schema, Types } from "mongoose";

interface VerificationCode {
  verificationId: string;
  userId: Types.ObjectId;
  channel: "email" | "phone";
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  resendAvailableAt: Date;
}

const schema = new Schema<VerificationCode>(
  {
    verificationId: { type: String, required: true, unique: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    channel: { type: String, enum: ["email", "phone"], required: true },
    codeHash: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true, expires: 0 },
    resendAvailableAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const VerificationCodeModel = mongoose.model<VerificationCode>(
  "VerificationCode",
  schema,
);
