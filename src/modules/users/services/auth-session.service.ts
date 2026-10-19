import type { CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { isValidObjectId } from "mongoose";
import { ENV } from "../../../config/env";
import {
  UserModel,
  type UserDocument,
} from "../../../database/models/users.schema";

export const AUTH_COOKIE = "hip_session";
const DAY_SECONDS = 24 * 60 * 60;
const REMEMBER_DAYS = 30;

export const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: ENV.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
};

export const createSession = (user: UserDocument, remember = false) => {
  const seconds = DAY_SECONDS * (remember ? REMEMBER_DAYS : 1);
  const token = jwt.sign({ version: user.sessionVersion }, ENV.JWT_SECRET, {
    algorithm: "HS256",
    subject: user.id,
    expiresIn: seconds,
    issuer: "hip",
    audience: "hip-web",
  });
  return {
    token,
    options: {
      ...cookieOptions,
      ...(remember ? { maxAge: seconds * 1000 } : {}),
    },
  };
};

export const readSession = async (token: string) => {
  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, ENV.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "hip",
      audience: "hip-web",
    });
    if (
      typeof decoded === "string" ||
      !decoded.sub ||
      !isValidObjectId(decoded.sub)
    ) {
      return null;
    }
    payload = decoded;
  } catch {
    return null;
  }
  // AUTH-012: the database, rather than JWT claims, decides current access.
  const user = await UserModel.findOne({
    _id: payload.sub,
    status: "active",
  }).select("+sessionVersion");
  return user && user.sessionVersion === payload.version ? user : null;
};

export const revokeSessions = async (userId?: string) => {
  if (userId) {
    await UserModel.updateOne({ _id: userId }, { $inc: { sessionVersion: 1 } });
  }
};
