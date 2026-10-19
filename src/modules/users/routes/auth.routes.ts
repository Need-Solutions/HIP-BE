import { Router } from "express";
import * as controller from "../controllers/auth.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import * as schema from "../validators/auth.validator";
import { validate } from "../../../shared/middleware/validate.middleware";

const UserAuthRoute = Router();

UserAuthRoute.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

UserAuthRoute.post("/user-signup", validate(schema.signupSchema), controller.signup);
UserAuthRoute.post("/user-verify", validate(schema.verifySchema), controller.verify);
UserAuthRoute.post("/user-verify/resend", validate(schema.resendSchema), controller.resend);
UserAuthRoute.post("/user-login", validate(schema.loginSchema), controller.login);
UserAuthRoute.post(
  "/user-logout",
  validate(schema.emptySchema),
  authMiddleware,
  controller.logout,
);
UserAuthRoute.post("/user-forgot", validate(schema.forgotSchema), controller.forgot);
UserAuthRoute.post("/user-reset", validate(schema.resetSchema), controller.reset);
UserAuthRoute.get("/me", authMiddleware, controller.me);

export default UserAuthRoute;
