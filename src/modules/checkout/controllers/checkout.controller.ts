import type { RequestHandler } from "express";
import * as checkout from "../services/checkout.service";
import { holdSeats } from "../services/seat-hold.service";
import { checkoutViewer } from "../services/checkout-access.service";
import { handlePaystackWebhook } from "../services/paystack-webhook.service";

export const hold: RequestHandler = async (req, res) => {
  res
    .status(200)
    .json(await holdSeats(req.body, checkoutViewer(req, res, true)));
};
export const start: RequestHandler = async (req, res) => {
  res
    .status(200)
    .json(await checkout.startCheckout(req.body, checkoutViewer(req, res)));
};
export const status: RequestHandler = async (req, res) => {
  res
    .status(200)
    .json(
      await checkout.checkoutStatus(req.params.id, checkoutViewer(req, res)),
    );
};
export const resume: RequestHandler = async (req, res) => {
  res
    .status(200)
    .json(
      await checkout.resumeCheckout(req.params.id, checkoutViewer(req, res)),
    );
};
export const webhook: RequestHandler = async (req, res) => {
  await handlePaystackWebhook(
    Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    req.get("x-paystack-signature"),
  );
  res.status(200).end();
};

export const quote: RequestHandler = async (req, res) => {
  res.json(await checkout.quote(req.body));
};
