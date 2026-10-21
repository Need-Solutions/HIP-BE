import type { RequestHandler } from "express";
import * as staff from "../services/staff.service";
import { STAFF_COOKIE } from "../services/auth-session.service";

export const list: RequestHandler = async (req, res) => {
  res.json(await staff.list(res.locals.staff));
};
export const invite: RequestHandler = async (req, res) => {
  res.json(await staff.invite(res.locals.staff, req.body));
};
export const resendInvite: RequestHandler = async (req, res) => {
  await staff.resendInvite(res.locals.staff, req.params.id);
  res.status(204).end();
};
export const changeRole: RequestHandler = async (req, res) => {
  res.json(
    await staff.changeRole(res.locals.staff, req.params.id, req.body.role),
  );
};
export const deactivate: RequestHandler = async (req, res) => {
  res.json(await staff.setActive(res.locals.staff, req.params.id, false));
};
export const activate: RequestHandler = async (req, res) => {
  res.json(await staff.setActive(res.locals.staff, req.params.id, true));
};
export const resetTwoStep: RequestHandler = async (req, res) => {
  res.json(await staff.resetTwoStep(res.locals.staff, req.params.id));
};
export const acceptInvite: RequestHandler = async (req, res) => {
  const result = await staff.acceptInvite(req.body.token, req.body.password);
  res.cookie(STAFF_COOKIE, result.session.token, result.session.options);
  res.json(result.data);
};
