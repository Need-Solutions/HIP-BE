import { Router } from "express";
import * as controller from "../controllers/user.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireHiker } from "../middlewares/hiker.middleware";
import { verifySchema } from "../validators/auth.validator";
import {
  profileUpdateSchema,
  contactIdSchema,
  notificationSchema,
} from "../validators/profile.validator";
import { validate } from "../../../shared/middleware/validate.middleware";

const UserRoute = Router();

UserRoute.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
UserRoute.use(authMiddleware, requireHiker);
UserRoute.get("/profile", controller.getProfile);
UserRoute.patch(
  "/profile",
  validate(profileUpdateSchema),
  controller.updateProfile,
);
UserRoute.post(
  "/contact/verify",
  validate(verifySchema),
  controller.confirmContact,
);
UserRoute.post(
  "/contact/resend",
  validate(contactIdSchema),
  controller.resendContactCode,
);
UserRoute.delete(
  "/contact/:verificationId",
  validate(contactIdSchema, "params"),
  controller.cancelContactChange,
);
UserRoute.get("/notifications", controller.getNotifications);
UserRoute.put(
  "/notifications",
  validate(notificationSchema),
  controller.updateNotifications,
);

export default UserRoute;
