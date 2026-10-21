import type { RequestHandler } from "express";
import * as service from "../services/transactions.service";
import type { TransactionsQuery } from "../validators/transactions.validator";
export const list: RequestHandler = async (req, res) => {
  res.json(await service.list(req.query as unknown as TransactionsQuery));
};
export const ticketDetail: RequestHandler = async (req, res) => {
  res.json(await service.ticketDetail(req.params.code));
};
