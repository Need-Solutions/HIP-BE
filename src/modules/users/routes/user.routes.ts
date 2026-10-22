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
import * as account from "../controllers/account.controller";
import {
  accountTicketsQuery,
  ticketCodeSchema,
  refundRequestSchema,
  historyQuerySchema,
  deleteAccountSchema,
} from "../validators/account.validator";
import { exportLimiter } from "../middlewares/export-limit.middleware";
import { imageUpload } from "../../events/middleware/cover-upload.middleware";

const UserRoute = Router();

UserRoute.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
UserRoute.use(authMiddleware, requireHiker);
UserRoute.get(
  "/tickets",
  validate(accountTicketsQuery, "query"),
  account.tickets,
);
UserRoute.get(
  "/tickets/:code",
  validate(ticketCodeSchema, "params"),
  account.ticket,
);
UserRoute.post(
  ["/tickets/:code/refund-request", "/tickets/:code/refund"],
  validate(ticketCodeSchema, "params"),
  validate(refundRequestSchema),
  account.refund,
);
UserRoute.get(
  "/refund-quote/:code",
  validate(ticketCodeSchema, "params"),
  account.quote,
);
UserRoute.get(
  "/history",
  validate(historyQuerySchema, "query"),
  account.history,
);
UserRoute.post("/photo", imageUpload("Choose a profile photo."), account.photo);
UserRoute.delete("/photo", account.deletePhoto);
UserRoute.get("/export", exportLimiter, account.download);
UserRoute.delete("/", validate(deleteAccountSchema), account.removeAccount);
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
