import { Router } from "express";
import * as controller from "../controllers/auth.controller";
import * as schema from "../validators/auth.validator";
import {
  requireStaff,
  staffAuthMiddleware,
} from "../middleware/auth.middleware";
import { validate } from "../../../shared/middleware/validate.middleware";
import { emptySchema } from "../../users/validators/auth.validator";
import { acceptInvite } from "../controllers/staff.controller";
import { acceptInviteSchema } from "../validators/staff.validator";

const AdminAuthRoute = Router();
AdminAuthRoute.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
AdminAuthRoute.post(
  "/invites/accept",
  validate(acceptInviteSchema),
  acceptInvite,
);
AdminAuthRoute.post(
  "/login",
  validate(schema.staffLoginSchema),
  controller.login,
);
AdminAuthRoute.post(
  "/verify",
  validate(schema.staffVerifySchema),
  controller.verify,
);
AdminAuthRoute.post(
  "/verify/resend",
  validate(schema.staffChallengeSchema),
  controller.resend,
);
AdminAuthRoute.use(staffAuthMiddleware);
AdminAuthRoute.get("/me", controller.me);
AdminAuthRoute.post("/logout", validate(emptySchema), controller.logout);
AdminAuthRoute.post(
  "/two-step/setup",
  requireStaff(true),
  validate(emptySchema),
  controller.setup,
);
AdminAuthRoute.post(
  "/two-step/enable",
  requireStaff(true),
  validate(schema.staffCodeSchema),
  controller.enable,
);

export default AdminAuthRoute;
