import { type FilterQuery, type Types } from "mongoose";
import {
  AuditLogModel,
  type IAuditLog,
} from "../../../database/models/audit-log.schema";
import { EventModel } from "../../../database/models/events.schema";
import { AdminModel } from "../../../database/models/admin.schema";
import { StaffInviteModel } from "../../../database/models/staff-invite.schema";
import { OrderModel } from "../../../database/models/orders.schema";
import type { AuditQuery, AUDIT_GROUPS } from "../validators/audit.validator";

const PAGE_SIZE = 12;
const escaped = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const objectIds = (ids: string[]) =>
  ids.filter((id) => /^[a-f\d]{24}$/i.test(id));
// Keep aligned with the frontend's lib/audit.ts. These are read filters, not new controller actions.
const groups: Record<(typeof AUDIT_GROUPS)[number], RegExp> = {
  events: /^event\./,
  payments: /^(order|payment)\./,
  attendance: /^(attendance|checkin)\./,
  refunds: /^refund\./,
  hikers: /^hiker\./,
  staff: /^staff\./,
  ads: /^ad\./,
  settings: /^(checkin_settings|notifications|branding|checkout)\./,
};
const labels: Record<string, string> = {
  "checkout.test_settlement_saved": "Test bank settings saved locally",
  "checkout.settings_updated": "Payment settings changed",
  "checkout.settlement_configured": "Settlement account configured",
  "event.created": "Event created",
  "event.updated": "Event updated",
  "event.published": "Event published",
  "event.sales_closed": "Ticket sales closed",
  "event.cancelled": "Event cancelled",
  "order.paid": "Payment confirmed",
  "payment.verification_failed": "Payment verification failed",
  "staff.invited": "Staff invited",
  "staff.invite_resent": "Invite resent",
  "staff.invite_cancelled": "Invite cancelled",
  "staff.invite_accepted": "Invite accepted",
  "staff.role_changed": "Role changed",
  "staff.activated": "Staff activated",
  "staff.deactivated": "Staff deactivated",
  "staff.two_factor_reset": "Two-step login reset",
};
const sameLabelCodes: Record<string, string[]> = {
  "ad.approved": ["ad.approved", "ad.activated"],
  "ad.activated": ["ad.approved", "ad.activated"],
};
const conflictActions = [
  "checkin.conflict_kept_earliest",
  "checkin.conflict_confirmed",
  "checkin.conflict_rejected",
  "checkin.conflict_resolved",
];
for (const action of conflictActions) sameLabelCodes[action] = conflictActions;

type AuditRow = IAuditLog & { _id: Types.ObjectId };
/** Both Overview and the full log serialize the same stored entries, with public record labels only. */
export async function response(rows: AuditRow[]) {
  const idsFor = (type: IAuditLog["target"]["type"]) =>
    rows.filter((row) => row.target.type === type).map((row) => row.target.id);
  const [events, staff, invites, orders] = await Promise.all([
    EventModel.find({ _id: { $in: objectIds(idsFor("event")) } })
      .select("title")
      .lean(),
    AdminModel.find({ _id: { $in: objectIds(idsFor("staff")) } })
      .select("fullName")
      .lean(),
    StaffInviteModel.find({
      $or: [
        { inviteId: { $in: idsFor("staff_invite") } },
        { _id: { $in: objectIds(idsFor("staff_invite")) } },
      ],
    })
      .select("inviteId name email")
      .lean(),
    OrderModel.find({ _id: { $in: objectIds(idsFor("checkout")) } })
      .select("reference")
      .lean(),
  ]);
  const names = new Map<string, string>([
    ...events.map((row): [string, string] => [`event:${row._id}`, row.title]),
    ...staff.map((row): [string, string] => [`staff:${row._id}`, row.fullName]),
    ...orders.map((row): [string, string] => [
      `checkout:${row._id}`,
      row.reference,
    ]),
  ]);
  for (const row of invites) {
    names.set(`staff_invite:${row.inviteId}`, row.name || row.email);
    names.set(`staff_invite:${row._id}`, row.name || row.email);
  }
  return rows.map((entry) => ({
    id: String(entry._id),
    actorUserId: entry.actor.id,
    actorName: entry.actor.name,
    action: entry.action,
    recordType: entry.target.type,
    recordId: entry.target.id,
    recordLabel:
      names.get(`${entry.target.type}:${entry.target.id}`) ??
      (entry.target.type === "checkout_settings"
        ? "Payments & settlement"
        : entry.target.id),
    details: entry.details,
    ...(entry.reason ? { reason: entry.reason } : {}),
    createdAt: entry.createdAt.toISOString(),
  }));
}

async function search(term: string): Promise<FilterQuery<IAuditLog>> {
  const regex = new RegExp(escaped(term), "i");
  const [events, staff, invites, orders] = await Promise.all([
    EventModel.find({ title: regex }).select("_id").lean(),
    AdminModel.find({ fullName: regex }).select("_id").lean(),
    StaffInviteModel.find({ $or: [{ name: regex }, { email: regex }] })
      .select("inviteId")
      .lean(),
    OrderModel.find({ reference: regex }).select("_id").lean(),
  ]);
  return {
    $or: [
      ...["details", "reason", "target.id", "actor.name", "action"].map(
        (field) => ({ [field]: regex }),
      ),
      {
        action: {
          $in: Object.keys(labels).filter((code) =>
            labels[code].toLowerCase().includes(term.toLowerCase()),
          ),
        },
      },
      {
        "target.type": "event",
        "target.id": { $in: events.map((row) => String(row._id)) },
      },
      {
        "target.type": "staff",
        "target.id": { $in: staff.map((row) => String(row._id)) },
      },
      {
        "target.type": "staff_invite",
        "target.id": {
          $in: invites.flatMap((row) => [row.inviteId, String(row._id)]),
        },
      },
      {
        "target.type": "checkout",
        "target.id": { $in: orders.map((row) => String(row._id)) },
      },
    ],
  };
}

export async function list(query: AuditQuery) {
  const filters: FilterQuery<IAuditLog>[] = [];
  if (query.action?.startsWith("group:"))
    filters.push({
      action: groups[query.action.slice(6) as keyof typeof groups],
    });
  else if (query.action)
    filters.push({
      action: { $in: sameLabelCodes[query.action] ?? [query.action] },
    });
  if (query.actorId) filters.push({ "actor.id": query.actorId });
  if (query.from || query.to)
    filters.push({
      createdAt: {
        ...(query.from
          ? { $gte: new Date(`${query.from}T00:00:00+01:00`) }
          : {}),
        ...(query.to
          ? {
              $lt: new Date(
                new Date(`${query.to}T00:00:00+01:00`).getTime() + 86400000,
              ),
            }
          : {}),
      },
    });
  if (query.q) filters.push(await search(query.q));
  const filter: FilterQuery<IAuditLog> = filters.length
    ? { $and: filters }
    : {};
  const page = query.all ? 1 : query.page;
  const find = AuditLogModel.find(filter).sort({ createdAt: -1, _id: -1 });
  if (!query.all) find.skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE);
  const [rows, total, actors] = await Promise.all([
    find.lean(),
    AuditLogModel.countDocuments(filter),
    // Keep historical/deactivated actors in the filter; names come from the newest entry for each actor.
    AuditLogModel.aggregate<{ id: string; name: string }>([
      { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: "$actor.id", name: { $first: "$actor.name" } } },
      { $sort: { name: 1, _id: 1 } },
      { $project: { _id: 0, id: "$_id", name: 1 } },
    ]),
  ]);
  return {
    items: await response(rows),
    total,
    page,
    pageSize: query.all ? total : PAGE_SIZE,
    actors,
  };
}
