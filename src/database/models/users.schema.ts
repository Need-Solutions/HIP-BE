import mongoose, { HydratedDocument, Schema } from "mongoose";
import { Role } from "../../shared/enums/user-role.enum";

export interface NotificationPrefs {
  ticketConfirmations: true;
  reminders: boolean;
  reminderChannel: "email_whatsapp" | "email" | "whatsapp";
  promotions: boolean;
}

export const defaultNotifications: NotificationPrefs = {
  ticketConfirmations: true,
  reminders: true,
  reminderChannel: "email_whatsapp",
  promotions: false,
};

export interface IUser {
  fullName: string;
  email: string;
  phone: string;
  passwordHash: string;
  roles: Role[];
  status: "active" | "unverified" | "suspended" | "deactivated";
  emailVerified: boolean;
  phoneVerified: boolean;
  sessionVersion: number;
  ticketChanges: number;
  dateOfBirth?: string;
  emergencyContact?: { name: string; phone: string };
  notifications: NotificationPrefs;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<NotificationPrefs>(
  {
    ticketConfirmations: { type: Boolean, default: true },
    reminders: { type: Boolean, default: true },
    reminderChannel: {
      type: String,
      enum: ["email_whatsapp", "email", "whatsapp"],
      default: "email_whatsapp",
    },
    promotions: { type: Boolean, default: false },
  },
  { _id: false },
);

const emergencyContactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
  },
  { _id: false },
);

const UserSchema = new Schema<IUser>(
  {
    fullName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
    },
    phone: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    roles: { type: [String], enum: Object.values(Role), default: [Role.HIKER] },
    status: {
      type: String,
      enum: ["active", "unverified", "suspended", "deactivated"],
      default: "unverified",
    },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    sessionVersion: { type: Number, default: 0, select: false },
    ticketChanges: { type: Number, default: 0, select: false },
    dateOfBirth: String,
    emergencyContact: { type: emergencyContactSchema, default: undefined },
    notifications: {
      type: notificationSchema,
      default: () => ({ ...defaultNotifications }),
    },
  },
  { timestamps: true },
);

// AUTH-004: unfinished signups may share a phone, verified accounts may not.
UserSchema.index(
  { phone: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["active", "suspended", "deactivated"] },
    },
  },
);

export type UserDocument = HydratedDocument<IUser>;
export const UserModel = mongoose.model<IUser>("User", UserSchema);

export const toUserResponse = (user: UserDocument) => ({
  id: user.id as string,
  fullName: user.fullName,
  email: user.email,
  phone: user.phone,
  roles: user.roles,
  status: user.status,
  emailVerified: user.emailVerified,
  phoneVerified: user.phoneVerified,
  createdAt: user.createdAt.toISOString(),
});
