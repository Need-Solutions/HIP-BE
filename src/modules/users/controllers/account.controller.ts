import type { RequestHandler } from "express";
import {
  accountTicket,
  listAccountTickets,
} from "../services/account-tickets.service";
import { requestRefund, refundQuote } from "../services/refund.service";
import { hikingHistory } from "../services/history.service";
import { uploadPhoto, removePhoto } from "../services/account-photo.service";
import { exportAccount, deleteAccount } from "../services/account.service";
import { AUTH_COOKIE, cookieOptions } from "../services/auth-session.service";
import type { AccountTicketsQuery } from "../validators/account.validator";

export const tickets: RequestHandler = async (req, res) => {
  res.json(
    await listAccountTickets(
      res.locals.user.id,
      req.query as unknown as AccountTicketsQuery,
    ),
  );
};
export const ticket: RequestHandler = async (req, res) => {
  res.json(await accountTicket(res.locals.user.id, req.params.code));
};
export const quote: RequestHandler = async (req, res) => {
  res.json(await refundQuote(res.locals.user.id, req.params.code));
};
export const refund: RequestHandler = async (req, res) => {
  res.json(await requestRefund(res.locals.user.id, req.params.code, req.body));
};
export const history: RequestHandler = async (req, res) => {
  const result = await hikingHistory(res.locals.user.id);
  res.json(req.query.includeTotals === "true" ? result : result.entries);
};
export const photo: RequestHandler = async (req, res) => {
  res.json(await uploadPhoto(res.locals.user.id, req.file!.buffer));
};
export const deletePhoto: RequestHandler = async (_req, res) => {
  res.json(await removePhoto(res.locals.user.id));
};
export const download: RequestHandler = async (_req, res) => {
  const data = await exportAccount(res.locals.user.id);
  res
    .set({
      "Content-Disposition": 'attachment; filename="hip-account-data.json"',
      "Content-Type": "application/json; charset=utf-8",
    })
    .json(data);
};
export const removeAccount: RequestHandler = async (req, res) => {
  await deleteAccount(res.locals.user.id, req.body.password);
  res.clearCookie(AUTH_COOKIE, cookieOptions).status(204).end();
};
