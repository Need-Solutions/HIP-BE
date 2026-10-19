import type { RequestHandler } from "express";
import { AppError } from "../../../shared/errors/app.error";
import {
  readStaffSession,
  STAFF_COOKIE,
  staffCookieOptions,
} from "../services/auth-session.service";

export const staffAuthMiddleware: RequestHandler = async (req, res, next) => {
  const token: unknown = req.cookies?.[STAFF_COOKIE];
  const session =
    typeof token === "string" ? await readStaffSession(token) : null;
  res.locals.staff = session?.admin ?? null;
  res.locals.staffScope = session?.scope ?? null;
  if (token && !session) res.clearCookie(STAFF_COOKIE, staffCookieOptions);
  next();
};

export const requireStaff =
  (allowSetup = false): RequestHandler =>
  (req, res, next) => {
    if (!res.locals.staff)
      return next(
        new AppError(
          401,
          "unauthenticated",
          "Please sign in as staff to continue.",
        ),
      );
    if (!allowSetup && res.locals.staffScope !== "full")
      return next(
        new AppError(
          403,
          "two_step_required",
          "Set up your authenticator to finish signing in.",
        ),
      );
    next();
  };
