import { Application } from "express";
import UserAuthRoute from "../modules/users/routes/auth.routes";
import UserRoute from "../modules/users/routes/user.routes";
import AdminAuthRoute from "../modules/admin/routes/auth.routes";
import AdminRoute from "../modules/admin/routes/admin.routes";
import EventRoute from "../modules/events/routes/event.routes";
import CheckoutRoute from "../modules/checkout/routes/checkout.routes";
import TicketRoute from "../modules/tickets/routes/ticket.routes";
import { webhook } from "../modules/checkout/controllers/checkout.controller";
import { AppError } from "../shared/errors/app.error";
import globalErrorHandler from "../utils/global-errors/global-error.handler";

const handleRoutes = (app: Application) => {
  // health check
  app.get("/api/health", (req, res) => {
    res.status(200).json({
      status: "success",
      message: "Server is up and running",
    });
  });

  app.use("/api/auth", UserAuthRoute);
  app.use("/api/me", UserRoute);
  app.use("/api/auth/staff", AdminAuthRoute);
  app.use("/api/admin", AdminRoute);
  app.use("/api/events", EventRoute);
  app.use("/api/checkout", CheckoutRoute);
  app.use("/api/tickets", TicketRoute);
  app.post("/api/webhooks/paystack", webhook);
  app.use((req, res, next) =>
    next(new AppError(404, "not_found", "Route not found.")),
  );

  app.use(globalErrorHandler);
};

export { handleRoutes };
