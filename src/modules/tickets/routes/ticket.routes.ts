import { Router } from "express";
import * as controller from "../controllers/ticket.controller";
import {
  ticketParams,
  ticketQuery,
  guestLinkSchema,
} from "../validators/ticket.validator";
import { validate } from "../../../shared/middleware/validate.middleware";
import { authMiddleware } from "../../users/middlewares/auth.middleware";

const router = Router();
router.use((req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  next();
});
router.use(authMiddleware);
router.post("/guest-link", validate(guestLinkSchema), controller.guestLink);
router.get(
  "/:code",
  validate(ticketParams, "params"),
  validate(ticketQuery, "query"),
  controller.byCode,
);
export default router;
