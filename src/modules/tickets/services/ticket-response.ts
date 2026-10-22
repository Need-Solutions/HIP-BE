import type { IEvent } from "../../../database/models/events.schema";
import type { TicketDocument } from "../../../database/models/tickets.schema";
import type { Types } from "mongoose";

export function ticketEvent(event: IEvent & { _id: Types.ObjectId }) {
  return {
    id: event._id.toString(),
    slug: event.slug,
    title: event.title,
    startsAt: event.startsAt!.toISOString(),
    durationLabel: event.durationLabel,
    meetingPoint: event.meetingPoint,
    location: event.location,
    ...(event.coverImageUrl ? { coverImageUrl: event.coverImageUrl } : {}),
  };
}
export function ticketDetails(
  ticket: TicketDocument,
  event: IEvent & { _id: Types.ObjectId },
) {
  return {
    id: ticket.id as string,
    code: ticket.code,
    eventId: ticket.eventId.toString(),
    ticketTypeId: ticket.ticketTypeId.toString(),
    ...(ticket.holderUserId
      ? { holderUserId: ticket.holderUserId.toString() }
      : {}),
    holder: {
      fullName: ticket.holder.fullName,
      ...(ticket.holder.email ? { email: ticket.holder.email } : {}),
      ...(ticket.holder.phone ? { phone: ticket.holder.phone } : {}),
    },
    isGuest: !ticket.holderUserId,
    paymentId: ticket.paymentId,
    // Existing frontend enums remain compatible. A requested refund also suppresses the signed QR.
    qrToken:
      ["confirmed", "checked_in"].includes(ticket.status) &&
      event.status !== "cancelled"
        ? ticket.qrToken
        : "",
    status:
      event.status === "cancelled"
        ? "cancelled"
        : ticket.status === "refund_pending"
          ? "pending"
          : ticket.status,
    issuedAt: ticket.issuedAt.toISOString(),
    ticketTypeName: ticket.ticketTypeName,
    event: ticketEvent(event),
  };
}
