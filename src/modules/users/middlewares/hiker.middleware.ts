import type { RequestHandler } from "express";
import { Role } from "../../../shared/enums/user-role.enum";
import { AppError } from "../../../shared/errors/app.error";

export const requireHiker: RequestHandler = (req, res, next) => {
  if (!res.locals.user) {
    next(new AppError(401, "unauthenticated", "Please log in to continue."));
    return;
  }
  if (!res.locals.user.roles.includes(Role.HIKER)) {
    next(
      new AppError(
        403,
        "forbidden",
        "This action is only available to hikers.",
      ),
    );
    return;
  }
  next();
};
