import type { RequestHandler } from "express";
import * as overview from "../services/overview.service";

export const get: RequestHandler = async (_req, res) => {
  res.json(await overview.get(res.locals.staff.role));
};
