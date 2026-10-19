import type { RequestHandler } from "express";
import { toUserResponse } from "../../../database/models/users.schema";
import {
  AUTH_COOKIE,
  cookieOptions,
  readSession,
} from "../services/auth-session.service";

// /auth/me returns null for an absent, expired, revoked or inactive session.
export const authMiddleware: RequestHandler = async (req, res, next) => {
  const token: unknown = req.cookies?.[AUTH_COOKIE];
  const user = typeof token === "string" ? await readSession(token) : null;
  res.locals.user = user ? toUserResponse(user) : null;
  if (token && !user) {
    res.clearCookie(AUTH_COOKIE, cookieOptions);
  }
  next();
};
