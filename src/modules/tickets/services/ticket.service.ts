import { Types } from "mongoose";
import { EventModel } from "../../../database/models/events.schema";
import { OrderModel } from "../../../database/models/orders.schema";
import { SeatHoldModel } from "../../../database/models/seat-hold.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { UserModel } from "../../../database/models/users.schema";
import { AppError } from "../../../shared/errors/app.error";
import { sendMail } from "../../../services/mail.service";
import { transaction } from "../../../shared/database/transaction";
import {
  type CheckoutViewer,
  viewerFilter,
} from "../../checkout/services/checkout-access.service";
import { expireHolds } from "../../checkout/services/seat-hold.service";
import { createGuestLink, guestCanView } from "./guest-link.service";
import { mergeGuestTickets } from "./ticket-linking.service";
import { ticketDetails, ticketEvent } from "./ticket-response";

export async function byCode(
  code: string,
  viewer: CheckoutViewer,
  token?: string,
) {
  const ticket = await TicketModel.findOne({ code });
  if (!ticket) throw new AppError(404, "not_found", "Ticket not found.");
  const owner = viewer.userId && String(ticket.holderUserId) === viewer.userId;
  const buyer = await OrderModel.exists({
    _id: ticket.orderId,
    ...viewerFilter(viewer),
  });
  if (
    !owner &&
    !buyer &&
    !(await guestCanView(ticket._id, viewer.ownerHash, token))
  )
    throw new AppError(404, "not_found", "Ticket not found.");
  const event = await EventModel.findById(ticket.eventId);
  if (!event) throw new AppError(404, "not_found", "Ticket not found.");
  return ticketDetails(ticket, event);
}
export async function myTickets(userId: string) {
  await expireHolds();
  // Reconcile any issuance that raced with account verification; only proven contacts are considered.
  await transaction(async (session) => {
    const user = await UserModel.findOneAndUpdate(
      { _id: userId, status: "active" },
      { $inc: { ticketChanges: 1 } },
      { new: true, session },
    );
    if (!user)
      throw new AppError(401, "unauthenticated", "Please log in to continue.");
    await mergeGuestTickets(user, session);
  });
  const orders = await OrderModel.find({ buyerUserId: userId });
  const bought = new Set(orders.map((order) => order.id));
  const tickets = await TicketModel.find({
    $or: [
      { holderUserId: userId },
      { orderId: { $in: orders.map((order) => order._id) } },
    ],
  }).sort({ issuedAt: -1, _id: 1 });
  const eventIds = [
    ...new Set([
      ...tickets.map((ticket) => String(ticket.eventId)),
      ...orders.map((order) => String(order.eventId)),
    ]),
  ];
  const events = new Map(
    (await EventModel.find({ _id: { $in: eventIds } })).map((event) => [
      event.id,
      event,
    ]),
  );
  const holds = new Map(
    (
      await SeatHoldModel.find({
        _id: { $in: orders.map((order) => order.holdId) },
        state: "active",
        expiresAt: { $gt: new Date() },
      })
    ).map((hold) => [hold.id, hold]),
  );
  return {
    tickets: tickets.flatMap((ticket) => {
      const event = events.get(String(ticket.eventId));
      return event
        ? [
            {
              ...ticketDetails(ticket, event),
              eventStatus: event.status,
              pricePaidKobo: ticket.pricePaidKobo,
              heldByMe: String(ticket.holderUserId) === userId,
              boughtByMe: bought.has(String(ticket.orderId)),
            },
          ]
        : [];
    }),
    pending: orders.flatMap((order) => {
      const hold = holds.get(String(order.holdId)),
        event = events.get(String(order.eventId));
      return order.status === "pending" && hold && event
        ? [
            {
              checkoutId: order.id as string,
              reference: order.reference,
              event: ticketEvent(event),
              lines: order.lines.map((line) => ({
                ticketTypeId: line.ticketTypeId.toString(),
                ticketTypeName: line.ticketTypeName,
                quantity: line.quantity,
              })),
              amountKobo: order.amountKobo,
              paymentChannel: order.paymentChannel,
              buyerEmail: order.buyer.email,
              holdExpiresAt: hold.expiresAt.toISOString(),
            },
          ]
        : [];
    }),
  };
}
export async function requestGuestLink(contact: string, code?: string) {
  // Requests always return the same 204, even for no match or mail-provider failure.
  const emailContact = contact.includes("@");
  const buyerOrders = await OrderModel.find({
    [emailContact ? "buyer.email" : "buyer.phone"]: contact,
    status: "paid",
  })
    .select("_id buyer")
    .limit(100);
  const tickets = await TicketModel.find({
    ...(code ? { code } : {}),
    $or: [
      { [emailContact ? "holder.email" : "holder.phone"]: contact },
      { orderId: { $in: buyerOrders.map((order) => order._id) } },
    ],
  }).limit(100);
  const messages = new Map<string, string[]>();
  for (const ticket of tickets) {
    const order = buyerOrders.find((item) => item._id.equals(ticket.orderId));
    const to =
      order?.buyer.email ??
      ticket.holder.email ??
      (await OrderModel.findById(ticket.orderId))?.buyer.email;
    if (!to) continue;
    const url = await createGuestLink(
      new Types.ObjectId(ticket.id),
      ticket.code,
    );
    const links = messages.get(to) ?? [];
    links.push(`${ticket.holder.fullName} — ${ticket.code}\n${url}`);
    messages.set(to, links);
  }
  for (const [to, links] of messages) {
    try {
      await sendMail({
        to,
        subject: "Your HIP ticket links",
        text: `${links.join("\n\n")}\n\nEach link works once and expires in 30 minutes.`,
      });
    } catch {
      /* The public reply must not reveal that a matching ticket exists. */
    }
  }
}
