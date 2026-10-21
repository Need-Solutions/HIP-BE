import { Router } from "express";
import * as controller from "../controllers/staff.controller";
import * as schema from "../validators/staff.validator";
import { staffAuthMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { validate } from "../../../shared/middleware/validate.middleware";
import { emptySchema } from "../../users/validators/auth.validator";
import * as events from "../../events/controllers/event.controller";
import * as eventSchema from "../../events/validators/event.validator";
import { coverUpload } from "../../events/middleware/cover-upload.middleware";
import * as overview from "../controllers/overview.controller";
import { overviewQuerySchema } from "../validators/overview.validator";
import * as audit from "../controllers/audit.controller";
import { auditQuerySchema } from "../validators/audit.validator";

import * as checkoutSettings from "../controllers/checkout-settings.controller";
import {
  checkoutSettingsSchema,
  settlementAccountSchema,
} from "../validators/checkout-settings.validator";

import * as transactions from "../controllers/transactions.controller";
import {
  transactionsQuerySchema,
  ticketCodeSchema,
} from "../validators/transactions.validator";

const AdminRoute = Router();
AdminRoute.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
AdminRoute.use(staffAuthMiddleware);

AdminRoute.get(
  "/checkout/settings",
  requirePermission("manage_settings"),
  checkoutSettings.get,
);
AdminRoute.put(
  "/checkout/settings",
  requirePermission("manage_settings"),
  validate(checkoutSettingsSchema),
  checkoutSettings.update,
);
AdminRoute.post(
  "/checkout/subaccount",
  requirePermission("manage_settings"),
  validate(settlementAccountSchema),
  checkoutSettings.registerAccount,
);

AdminRoute.get(
  "/transactions",
  requirePermission("sell_refund_tickets"),
  validate(transactionsQuerySchema, "query"),
  transactions.list,
);
AdminRoute.get(
  "/tickets/:code",
  requirePermission("sell_refund_tickets"),
  validate(ticketCodeSchema, "params"),
  transactions.ticketDetail,
);

AdminRoute.get(
  "/overview",
  requirePermission("view_analytics"),
  validate(overviewQuerySchema, "query"),
  overview.get,
);
AdminRoute.get(
  "/audit-log",
  requirePermission("view_audit_log"),
  validate(auditQuerySchema, "query"),
  audit.list,
);

AdminRoute.get(
  "/events",
  requirePermission("manage_events"),
  validate(eventSchema.adminEventsQuerySchema, "query"),
  events.adminList,
);
AdminRoute.post(
  "/events",
  requirePermission("manage_events"),
  validate(eventSchema.createEventSchema),
  events.create,
);
AdminRoute.get(
  "/events/:id",
  requirePermission("manage_events"),
  validate(eventSchema.eventIdSchema, "params"),
  events.adminDetail,
);
AdminRoute.put(
  "/events/:id",
  requirePermission("manage_events"),
  validate(eventSchema.eventIdSchema, "params"),
  validate(eventSchema.updateEventSchema),
  events.update,
);
AdminRoute.post(
  "/events/:id/close-sales",
  requirePermission("manage_events"),
  validate(eventSchema.eventIdSchema, "params"),
  validate(emptySchema),
  events.closeSales,
);
AdminRoute.post(
  "/events/:id/cancel",
  requirePermission("manage_events"),
  validate(eventSchema.eventIdSchema, "params"),
  validate(eventSchema.cancelEventSchema),
  events.cancel,
);
AdminRoute.post(
  "/uploads/cover",
  requirePermission("manage_events"),
  coverUpload,
  events.cover,
);

// Every /api/admin route must declare its permission before validating input.
AdminRoute.get("/staff", requirePermission("manage_staff"), controller.list);
AdminRoute.post(
  "/staff/invites",
  requirePermission("manage_staff"),
  validate(schema.inviteSchema),
  controller.invite,
);
AdminRoute.post(
  "/staff/invites/:id/resend",
  requirePermission("manage_staff"),
  validate(schema.staffParamsSchema, "params"),
  validate(emptySchema),
  controller.resendInvite,
);
AdminRoute.put(
  "/staff/:id/role",
  requirePermission("manage_staff"),
  validate(schema.staffParamsSchema, "params"),
  validate(schema.roleSchema),
  controller.changeRole,
);
AdminRoute.post(
  "/staff/:id/deactivate",
  requirePermission("manage_staff"),
  validate(schema.staffParamsSchema, "params"),
  validate(emptySchema),
  controller.deactivate,
);
AdminRoute.post(
  "/staff/:id/activate",
  requirePermission("manage_staff"),
  validate(schema.staffParamsSchema, "params"),
  validate(emptySchema),
  controller.activate,
);
AdminRoute.post(
  "/staff/:id/two-factor/reset",
  requirePermission("manage_staff"),
  validate(schema.staffParamsSchema, "params"),
  validate(emptySchema),
  controller.resetTwoStep,
);

export default AdminRoute;
