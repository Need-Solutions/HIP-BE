import { Router } from "express";
import * as controller from "../controllers/event.controller";
import * as schema from "../validators/event.validator";
import { validate } from "../../../shared/middleware/validate.middleware";

const EventRoute = Router();
EventRoute.get(
  "/",
  validate(schema.publicEventsQuerySchema, "query"),
  controller.publicList,
);
EventRoute.get("/:id/ticket-types", controller.ticketTypes);
EventRoute.get("/:idOrSlug", controller.publicDetail);
export default EventRoute;
