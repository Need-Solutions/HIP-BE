import type { RequestHandler } from "express";
import { AppError } from "../../../shared/errors/app.error";
import {
  hasPermission,
  type Permission,
} from "../../../shared/permissions/staff-permissions";
import { requireStaff } from "./auth.middleware";

export const staffPermissionError = (permission: Permission) =>
  new AppError(
    403,
    "forbidden",
    permission === "manage_staff"
      ? "Only a super admin can manage staff."
      : "You don’t have permission to do that.",
  );

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, res, next) => {
    requireStaff()(req, res, (error) => {
      if (error) return next(error);
      if (!hasPermission(res.locals.staff.role, permission))
        return next(staffPermissionError(permission));
      next();
    });
  };
