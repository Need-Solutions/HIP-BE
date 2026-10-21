import { AdminRole } from "../../database/models/admin.schema";

// Keep aligned with hip-frontend/src/lib/permissions.ts. Ownership checks belong in each service.
export type Permission =
  | "manage_events"
  | "sell_refund_tickets"
  | "check_in"
  | "correct_attendance"
  | "view_analytics"
  | "manage_ads"
  | "review_ads"
  | "manage_settings"
  | "view_audit_log"
  | "manage_staff"
  | "view_hikers"
  | "suspend_hikers";

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  super_admin: [
    "manage_events",
    "sell_refund_tickets",
    "check_in",
    "correct_attendance",
    "view_analytics",
    "manage_ads",
    "review_ads",
    "manage_settings",
    "view_audit_log",
    "manage_staff",
    "view_hikers",
    "suspend_hikers",
  ],
  admin: [
    "manage_events",
    "sell_refund_tickets",
    "check_in",
    "correct_attendance",
    "view_analytics",
    "manage_ads",
    "review_ads",
    "view_hikers",
    "suspend_hikers",
  ],
  checkin_staff: ["check_in"],
  advertiser: ["manage_ads"],
};

export const hasPermission = (role: AdminRole, permission: Permission) =>
  ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
