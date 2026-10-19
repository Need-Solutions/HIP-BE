import mongoose, { HydratedDocument, Schema } from "mongoose";

export enum AdminRole {
  SUPER_ADMIN = "super_admin",
  ADMIN = "admin",
  CHECKIN_STAFF = "checkin_staff",
  ADVERTISER = "advertiser",
}

export interface IAdmin {
  fullName: string;
  email: string;
  passwordHash: string;
  role: AdminRole;
  status: "active" | "deactivated";
  authenticatorSecret?: string;
  twoStepEnabled: boolean;
  sessionVersion: number;
  setupExpiresAt?: Date;
  setupAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const AdminSchema = new Schema<IAdmin>(
  {
    fullName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(AdminRole), required: true },
    status: {
      type: String,
      enum: ["active", "deactivated"],
      default: "active",
    },
    authenticatorSecret: { type: String, select: false },
    twoStepEnabled: { type: Boolean, default: false },
    sessionVersion: { type: Number, default: 0, select: false },
    setupExpiresAt: { type: Date, select: false },
    setupAttempts: { type: Number, default: 0, select: false },
  },
  { timestamps: true },
);

export const AdminModel = mongoose.model<IAdmin>("Admin", AdminSchema);
export type AdminDocument = HydratedDocument<IAdmin>;

// Matches the frontend User contract; staff have no hiker phone or attendance record.
export const toStaffResponse = (admin: AdminDocument) => ({
  id: admin.id as string,
  fullName: admin.fullName,
  email: admin.email,
  phone: "",
  roles: [admin.role],
  status: admin.status,
  emailVerified: true,
  phoneVerified: false,
  createdAt: admin.createdAt.toISOString(),
});
