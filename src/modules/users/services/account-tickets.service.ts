import type { ClientSession } from "mongoose";
import { UserModel } from "../../../database/models/users.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { OrderModel } from "../../../database/models/orders.schema";
import { EventModel } from "../../../database/models/events.schema";
import {
  RefundRequestModel,
  type RefundDocument,
} from "../../../database/models/refund-request.schema";
import { CheckInModel } from "../../../database/models/check-in.schema";
import { AppError } from "../../../shared/errors/app.error";
import { transaction } from "../../../shared/database/transaction";
import { mergeGuestTickets } from "../../tickets/services/ticket-linking.service";
import { myTickets } from "../../tickets/services/ticket.service";
import { ticketDetails } from "../../tickets/services/ticket-response";
import { eventEnded } from "./account-event-time";
import type { AccountTicketsQuery } from "../validators/account.validator";

export const refundResponse = (refund: RefundDocument) => ({
  status:
    refund.status === "paid"
      ? "refunded"
      : refund.status === "rejected"
        ? "declined"
        : "requested",
  amountKobo: refund.amountKobo,
  requestedAt: refund.createdAt.toISOString(),
  ...(["paid", "rejected"].includes(refund.status)
    ? { processedAt: refund.updatedAt.toISOString() }
    : {}),
  reason: refund.reason,
});
export async function reconcileAccount(userId: string) {
  await transaction(async (session) => {
    const user = await UserModel.findOneAndUpdate(
      { _id: userId, status: "active" },
      { $inc: { ticketChanges: 1 } },
      { new: true, session },
    );
    if (!user)
      throw new AppError(401, "unauthenticated", "Please log in to continue.");
    await mergeGuestTickets(user, session);
    // A guest admission whose ticket was subsequently linked also belongs in the hiker's history.
    const held = await TicketModel.find({ holderUserId: userId })
      .select("_id")
      .session(session);
    await CheckInModel.updateMany(
      { ticket: { $in: held.map((t) => t._id) }, user: { $exists: false } },
      { $set: { user: user._id } },
      { session },
    );
  });
}
export async function ownedTicket(
  userId: string,
  code: string,
  session?: ClientSession,
) {
  const ticket = await TicketModel.findOne({ code }).session(session ?? null);
  if (!ticket) throw new AppError(404, "not_found", "Ticket not found.");
  const order = await OrderModel.findById(ticket.orderId).session(
    session ?? null,
  );
  const heldByMe = String(ticket.holderUserId) === userId;
  const boughtByMe = String(order?.buyerUserId) === userId;
  if (!heldByMe && !boughtByMe)
    throw new AppError(404, "not_found", "Ticket not found.");
  const event = await EventModel.findById(ticket.eventId).session(
    session ?? null,
  );
  if (!event || !order)
    throw new AppError(404, "not_found", "Ticket not found.");
  return { ticket, event, order, heldByMe, boughtByMe };
}
export async function listAccountTickets(
  userId: string,
  query: AccountTicketsQuery,
) {
  await reconcileAccount(userId);
  const result = await myTickets(userId);
  const events = new Map(
    (
      await EventModel.find({
        _id: { $in: result.tickets.map((t) => t.eventId) },
      })
    ).map((e) => [e.id, e]),
  );
  const refunds = new Map(
    (
      await RefundRequestModel.find({
        ticket: { $in: result.tickets.map((t) => t.id) },
      })
    ).map((r) => [String(r.ticket), r]),
  );
  const checkIns = new Map(
    (
      await CheckInModel.find({
        ticket: { $in: result.tickets.map((t) => t.id) },
      })
    ).map((c) => [String(c.ticket), c]),
  );
  const tickets = result.tickets.map((ticket) => {
    const refund = refunds.get(ticket.id),
      checkIn = checkIns.get(ticket.id);
    return {
      ...ticket,
      ...(refund ? { refund: refundResponse(refund) } : {}),
      ...(checkIn
        ? {
            checkIn: {
              at: checkIn.checkedInAt.toISOString(),
              method: checkIn.method,
            },
          }
        : {}),
    };
  });
  const tabFor = (ticket: (typeof tickets)[number]) => {
    if (
      ["cancelled", "refunded"].includes(ticket.status) ||
      ticket.eventStatus === "cancelled"
    )
      return "cancelled";
    const event = events.get(ticket.eventId);
    return event && eventEnded(event) ? "past" : "upcoming";
  };
  const counts = {
    upcoming: 0,
    upcomingBoughtForOthers: 0,
    past: 0,
    cancelled: 0,
    pending: result.pending.length,
  };
  for (const ticket of tickets) {
    const tab = tabFor(ticket);
    if (tab === "upcoming" && !ticket.heldByMe)
      counts.upcomingBoughtForOthers++;
    else counts[tab]++;
  }
  const selected = tickets
    .filter((t) => !query.tab || tabFor(t) === query.tab)
    .sort(
      (a, b) =>
        (query.tab === "upcoming" ? 1 : -1) *
          a.event.startsAt.localeCompare(b.event.startsAt) ||
        a.code.localeCompare(b.code),
    );
  return {
    tickets: selected.slice(
      (query.page - 1) * query.pageSize,
      query.page * query.pageSize,
    ),
    pending: !query.tab || query.tab === "upcoming" ? result.pending : [],
    page: query.page,
    pageSize: query.pageSize,
    total: selected.length,
    totalPages: Math.ceil(selected.length / query.pageSize),
    counts,
  };
}
export async function accountTicket(userId: string, code: string) {
  await reconcileAccount(userId);
  const { ticket, event, heldByMe, boughtByMe } = await ownedTicket(
    userId,
    code,
  );
  const refund = await RefundRequestModel.findOne({ ticket: ticket._id });
  const checkIn = await CheckInModel.findOne({ ticket: ticket._id });
  return {
    ...ticketDetails(ticket, event),
    eventStatus: event.status,
    pricePaidKobo: ticket.pricePaidKobo,
    heldByMe,
    boughtByMe,
    ...(checkIn
      ? {
          checkIn: {
            at: checkIn.checkedInAt.toISOString(),
            method: checkIn.method,
          },
        }
      : {}),
    ...(refund ? { refund: refundResponse(refund) } : {}),
  };
}
