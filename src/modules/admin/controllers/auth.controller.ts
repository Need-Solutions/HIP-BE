import type { RequestHandler } from "express";
import { toStaffResponse } from "../../../database/models/admin.schema";
import { AppError } from "../../../shared/errors/app.error";
import * as auth from "../services/auth.service";
import * as twoStep from "../services/two-step.service";
import {
  STAFF_COOKIE,
  staffCookieOptions,
  revokeStaffSessions,
} from "../services/auth-session.service";

export const login: RequestHandler = async (req, res) => {
  res.json(await auth.login(req.body.email, req.body.password));
};
export const verify: RequestHandler = async (req, res) => {
  const result = await auth.verify(req.body.challengeId, req.body.code);
  res.cookie(STAFF_COOKIE, result.session.token, result.session.options);
  res.json(result.data);
};
export const resend: RequestHandler = async (req, res) => {
  res.json(await auth.resend(req.body.challengeId));
};
export const setup: RequestHandler = async (req, res) => {
  res.json(await twoStep.setup(res.locals.staff));
};
export const enable: RequestHandler = async (req, res) => {
  const result = await twoStep.enable(res.locals.staff, req.body.code);
  res.cookie(STAFF_COOKIE, result.session.token, result.session.options);
  res.json(result.data);
};
export const logout: RequestHandler = async (req, res) => {
  await revokeStaffSessions(res.locals.staff?.id);
  res.clearCookie(STAFF_COOKIE, staffCookieOptions);
  res.status(204).end();
};
export const me: RequestHandler = (req, res) => {
  if (res.locals.staff && res.locals.staffScope !== "full")
    throw new AppError(
      403,
      "two_step_required",
      "Set up your authenticator to finish signing in.",
    );
  res.json(res.locals.staff ? toStaffResponse(res.locals.staff) : null);
};
