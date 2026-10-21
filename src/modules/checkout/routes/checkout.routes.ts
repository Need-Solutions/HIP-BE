import { Router } from "express";
import * as controller from "../controllers/checkout.controller";
import * as schema from "../validators/checkout.validator";
import { validate } from "../../../shared/middleware/validate.middleware";
import { authMiddleware } from "../../users/middlewares/auth.middleware";

const router = Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(authMiddleware);
router.post("/quote", validate(schema.holdSchema), controller.quote);
router.post("/holds", validate(schema.holdSchema), controller.hold);
router.post("/", validate(schema.checkoutSchema), controller.start);
router.get(
  "/:id",
  validate(schema.checkoutIdSchema, "params"),
  controller.status,
);
router.post(
  "/:id/resume",
  validate(schema.checkoutIdSchema, "params"),
  controller.resume,
);
export default router;
