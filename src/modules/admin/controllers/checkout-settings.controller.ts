import type { RequestHandler } from "express";
import * as service from "../services/checkout-settings.service";

export const get: RequestHandler = async (_req, res) => {
  res.json(await service.get());
};
export const update: RequestHandler = async (req, res) => {
  res.json(await service.update(req.body, res.locals.staff));
};
export const registerAccount: RequestHandler = async (req, res) => {
  res.json(await service.registerAccount(req.body, res.locals.staff));
};
