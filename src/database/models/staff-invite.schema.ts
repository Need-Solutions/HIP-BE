import mongoose, { Schema, type HydratedDocument } from "mongoose";
import { AdminRole } from "./admin.schema";

export interface IStaffInvite {
  inviteId: string;
  name: string;
  email: string;
  role: AdminRole;
  tokenHash: string;
  expiresAt: Date;
  state: "pending" | "accepted" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
}

const StaffInviteSchema = new Schema<IStaffInvite>(
  {
    inviteId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    role: { type: String, enum: Object.values(AdminRole), required: true },
    tokenHash: { type: String, required: true, select: false, unique: true },
    expiresAt: { type: Date, required: true },
    state: {
      type: String,
      enum: ["pending", "accepted", "cancelled"],
      default: "pending",
    },
  },
  { timestamps: true },
);

// Accepted/cancelled invitations remain as history; only one pending invitation may claim an email.
StaffInviteSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { state: "pending" } },
);

export const StaffInviteModel = mongoose.model<IStaffInvite>(
  "StaffInvite",
  StaffInviteSchema,
);
export type StaffInviteDocument = HydratedDocument<IStaffInvite>;
