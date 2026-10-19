import mongoose, { Schema, Types } from "mongoose";

interface PasswordReset {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

const schema = new Schema<PasswordReset>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true, expires: 0 },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const PasswordResetModel = mongoose.model<PasswordReset>(
  "PasswordReset",
  schema,
);
