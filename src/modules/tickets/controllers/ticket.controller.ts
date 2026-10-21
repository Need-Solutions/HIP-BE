import type { RequestHandler } from "express";
import * as tickets from "../services/ticket.service";
import { checkoutViewer } from "../../checkout/services/checkout-access.service";

export const mine: RequestHandler = async (req, res) => {
  res.status(200).json(await tickets.myTickets(res.locals.user.id));
};
export const byCode: RequestHandler = async (req, res) => {
  res
    .status(200)
    .json(
      await tickets.byCode(
        req.params.code,
        checkoutViewer(req, res, Boolean(req.query.token)),
        req.query.token as string | undefined,
      ),
    );
};
export const guestLink: RequestHandler = async (req, res) => {
  await tickets.requestGuestLink(req.body.contact, req.body.code);
  res.status(204).end();
};
