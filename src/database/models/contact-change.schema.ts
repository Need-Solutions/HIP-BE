import mongoose, { Schema, Types } from "mongoose";

interface ContactChange {
  userId: Types.ObjectId;
  verificationId: string;
  field: "email" | "phone";
  value: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  resendAvailableAt: Date;
}

const schema = new Schema<ContactChange>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    verificationId: { type: String, required: true, unique: true },
    field: { type: String, enum: ["email", "phone"], required: true },
    value: { type: String, required: true },
    codeHash: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true, expires: 0 },
    resendAvailableAt: { type: Date, required: true },
  },
  { timestamps: true },
);

schema.index({ userId: 1, field: 1 }, { unique: true });

export const ContactChangeModel = mongoose.model<ContactChange>(
  "ContactChange",
  schema,
);
