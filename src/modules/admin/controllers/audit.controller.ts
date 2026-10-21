import type { RequestHandler } from "express";
import * as audit from "../services/audit-query.service";
import type { AuditQuery } from "../validators/audit.validator";

export const list: RequestHandler = async (req, res) => {
  res.json(await audit.list(req.query as unknown as AuditQuery));
};
