import { Application } from "express";
import UserAuthRoute from "../modules/users/routes/auth.routes";
import UserRoute from "../modules/users/routes/user.routes";
import AdminAuthRoute from "../modules/admin/routes/auth.routes";
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
  app.use((req, res, next) =>
    next(new AppError(404, "not_found", "Route not found.")),
  );

  app.use(globalErrorHandler);
};

export { handleRoutes };
