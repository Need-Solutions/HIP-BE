import type { CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { isValidObjectId } from "mongoose";
import { ENV } from "../../../config/env";
import {
  AdminModel,
  type AdminDocument,
} from "../../../database/models/admin.schema";
import { StaffChallengeModel } from "../../../database/models/staff-challenge.schema";

export const STAFF_COOKIE = "hip_staff_session";
export const staffCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: ENV.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
};
export type StaffScope = "setup" | "full";

export const createStaffSession = (admin: AdminDocument, scope: StaffScope) => {
  const seconds = scope === "setup" ? 10 * 60 : 24 * 60 * 60;
  return {
    token: jwt.sign({ version: admin.sessionVersion, scope }, ENV.JWT_SECRET, {
      algorithm: "HS256",
      subject: admin.id,
      expiresIn: seconds,
      issuer: "hip",
      audience: "hip-staff",
    }),
    options: {
      ...staffCookieOptions,
      ...(scope === "setup" ? { maxAge: seconds * 1000 } : {}),
    },
  };
};

export const readStaffSession = async (token: string) => {
  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, ENV.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "hip",
      audience: "hip-staff",
    });
    if (
      typeof decoded === "string" ||
      !decoded.sub ||
      !isValidObjectId(decoded.sub) ||
      !["setup", "full"].includes(decoded.scope)
    )
      return null;
    payload = decoded;
  } catch {
    return null;
  }
  const admin = await AdminModel.findOne({
    _id: payload.sub,
    status: "active",
  }).select("+sessionVersion");
  if (
    !admin ||
    admin.sessionVersion !== payload.version ||
    (payload.scope === "full") !== admin.twoStepEnabled
  )
    return null;
  const now = new Date();
  if (
    !admin.lastActiveAt ||
    now.getTime() - admin.lastActiveAt.getTime() >= 60000
  ) {
    await AdminModel.updateOne(
      { _id: admin._id, status: "active", sessionVersion: payload.version },
      { $set: { lastActiveAt: now } },
    );
    admin.lastActiveAt = now;
  }
  return { admin, scope: payload.scope as StaffScope };
};

export const revokeStaffSessions = async (adminId?: string) => {
  if (!adminId) return;
  await AdminModel.updateOne({ _id: adminId }, { $inc: { sessionVersion: 1 } });
  await StaffChallengeModel.deleteMany({ adminId });
};
