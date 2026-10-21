import type { RequestHandler } from "express";
import * as events from "../services/event.service";
import * as queries from "../services/event-query.service";
import { uploadCover } from "../../../services/cover.service";
import type {
  AdminEventsQuery,
  PublicEventsQuery,
} from "../validators/event.validator";

export const create: RequestHandler = async (req, res) => {
  res.json(await events.save(res.locals.staff, req.body));
};
export const update: RequestHandler = async (req, res) => {
  res.json(await events.save(res.locals.staff, req.body, req.params.id));
};
export const adminList: RequestHandler = async (req, res) => {
  res.json(await queries.adminList(req.query as unknown as AdminEventsQuery));
};
export const adminDetail: RequestHandler = async (req, res) => {
  res.json(await queries.adminDetail(req.params.id));
};
export const closeSales: RequestHandler = async (req, res) => {
  res.json(await events.closeSales(res.locals.staff, req.params.id));
};
export const cancel: RequestHandler = async (req, res) => {
  res.json(
    await events.cancel(res.locals.staff, req.params.id, req.body.reason),
  );
};
export const cover: RequestHandler = async (req, res) => {
  res.json(await uploadCover(req.file!.buffer));
};
export const publicList: RequestHandler = async (req, res) => {
  res.json(await queries.publicList(req.query as unknown as PublicEventsQuery));
};
export const publicDetail: RequestHandler = async (req, res) => {
  res.json(await queries.publicDetail(req.params.idOrSlug));
};
export const ticketTypes: RequestHandler = async (req, res) => {
  res.json(await queries.publicTicketTypes(req.params.id));
};
