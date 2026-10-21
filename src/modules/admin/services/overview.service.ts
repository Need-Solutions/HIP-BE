import type { AdminRole } from "../../../database/models/admin.schema";
import { UserModel } from "../../../database/models/users.schema";
import { OrderModel } from "../../../database/models/orders.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { EventModel } from "../../../database/models/events.schema";
import { AuditLogModel } from "../../../database/models/audit-log.schema";
import { hasPermission } from "../../../shared/permissions/staff-permissions";
import { adminRows } from "../../events/services/event-query.service";
import * as audit from "./audit-query.service";

import {
  orderNetRevenue,
  testPayment,
} from "../../checkout/services/order-finance";

const DAY = 86400000;
const WEEK = 7 * DAY;
const LAGOS_OFFSET = 3600000;

/** Monday 00:00 in Africa/Lagos, expressed as a UTC instant. */
export function weekStart(at: Date, weeksBack = 0) {
  const local = new Date(at.getTime() + LAGOS_OFFSET);
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      sinceMonday * DAY -
      LAGOS_OFFSET -
      weeksBack * WEEK,
  );
}

function weekLabel(start: Date) {
  const thursday = new Date(start.getTime() + LAGOS_OFFSET + 3 * DAY);
  const january4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstThursday =
    january4.getTime() + (3 - ((january4.getUTCDay() + 6) % 7)) * DAY;
  return `W${1 + Math.round((thursday.getTime() - firstThursday) / WEEK)}`;
}

export async function get(role: AdminRole, now = new Date()) {
  const start = weekStart(now);
  const previousStart = weekStart(now, 1);
  const nextStart = new Date(start.getTime() + WEEK);
  const [registeredHikers, sales, events, activity] = await Promise.all([
    // Completed registrations, including suspended/deactivated members; never guests, staff or unfinished signups.
    UserModel.countDocuments({ roles: "hiker", status: { $ne: "unverified" } }),
    OrderModel.aggregate<{
      _id: "current" | "previous";
      tickets: number;
      netKobo: number;
      testNetKobo: number;
    }>([
      {
        $match: {
          status: "paid",
          currency: "NGN",
          paymentReview: { $ne: true },
          paidAt: { $gte: previousStart, $lt: nextStart },
        },
      },
      // Count actual issued tickets, not holds or the buyer's requested quantity. One order's revenue is added once.
      {
        $lookup: {
          from: TicketModel.collection.name,
          let: { orderId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$orderId", "$$orderId"] } } },
            { $count: "count" },
          ],
          as: "issued",
        },
      },
      {
        $group: {
          _id: { $cond: [{ $gte: ["$paidAt", start] }, "current", "previous"] },
          tickets: {
            $sum: { $ifNull: [{ $arrayElemAt: ["$issued.count", 0] }, 0] },
          },
          netKobo: { $sum: orderNetRevenue },
          testNetKobo: { $sum: { $cond: [testPayment, orderNetRevenue, 0] } },
        },
      },
    ]),
    EventModel.find({
      startsAt: { $gte: now },
      status: { $in: ["draft", "published", "sales_closed"] },
    })
      .sort({ startsAt: 1, _id: 1 })
      .limit(4)
      .lean(),
    // Admins see operational activity only. Staff-management audit details remain super-admin-only.
    AuditLogModel.find(
      hasPermission(role, "view_audit_log")
        ? {}
        : { "target.type": { $in: ["event", "checkout"] } },
    )
      .select("actor action target details reason createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .limit(4)
      .lean(),
  ]);
  const current = sales.find((row) => row._id === "current");
  const previous = sales.find((row) => row._id === "previous");
  return {
    weekStart: start.toISOString(),
    weekEnd: new Date(nextStart.getTime() - 1).toISOString(),
    registeredHikers,
    // TODO (check-in controller): aggregate recorded check-ins, never tickets or ticket.status.
    attendance: { instances: 0, uniqueHikers: 0, previousInstances: 0 },
    ticketsSold: {
      value: current?.tickets ?? 0,
      previous: previous?.tickets ?? 0,
    },
    // The frozen policy determines group proceeds; test sales are identified separately from payouts.
    // TODO (refund controller): deduct recorded completed refunds in the week they are processed.
    netRevenueKobo: {
      value: current?.netKobo ?? 0,
      previous: previous?.netKobo ?? 0,
    },
    testRevenueKobo: {
      value: current?.testNetKobo ?? 0,
      previous: previous?.testNetKobo ?? 0,
    },
    weekly: Array.from({ length: 8 }, (_, index) => {
      const week = weekStart(now, 7 - index);
      return {
        week: weekLabel(week),
        startsOn: week.toISOString(),
        instances: 0,
        uniqueHikers: 0,
      };
    }),
    upcoming: await adminRows(events, now),
    activity: await audit.response(activity),
    // No refund-request controller or ledger exists yet.
    pendingRefunds: 0,
  };
}
