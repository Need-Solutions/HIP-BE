import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { promisify } from "util";
import mongoose, { type ClientSession } from "mongoose";
import { ENV } from "../../../config/env";
import { EventModel } from "../../../database/models/events.schema";
import {
  OrderModel,
  type OrderDocument,
} from "../../../database/models/orders.schema";
import { SeatHoldModel } from "../../../database/models/seat-hold.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { TicketTypeModel } from "../../../database/models/ticket-types.schema";
import { UserModel } from "../../../database/models/users.schema";
import type { PaymentVerification } from "../../../services/paystack.service";
import { transaction } from "../../../shared/database/transaction";
import { encrypt } from "../../../shared/security/encryption";
import {
  eventSigningKey,
  signTicket,
  ticketCode,
} from "../../tickets/services/ticket-qr.service";
import { createGuestLink } from "../../tickets/services/guest-link.service";
import { verifiedContactUser } from "../../tickets/services/ticket-linking.service";
import { inventoryLeft, releaseHold } from "./seat-hold.service";
import { paymentAudit } from "./payment-audit.service";
import type { TicketMail } from "./checkout-mail.service";
import { verifiedSplit, verifiedTestPayment } from "./payment-split";

const REVIEW =
  "We received a payment confirmation but could not issue your tickets. Contact the group with your payment reference before paying again.";
const hashPassword = promisify(bcrypt.hash);
async function fail(
  order: OrderDocument,
  session: ClientSession,
  reason: string,
  review = false,
) {
  order.status = "failed";
  order.failureReason = review
    ? REVIEW
    : "Your payment didn’t go through. Please start again.";
  order.paymentReview = review;
  const hold = await SeatHoldModel.findById(order.holdId).session(session);
  if (hold?.state === "active") await releaseHold(hold, session);
  await order.save({ session });
  await paymentAudit(order, "payment.verification_failed", reason, session);
}
export async function confirmOrder(
  id: string,
  verification?: PaymentVerification,
) {
  // Unique code/key collisions are rare, but must roll the whole issuance back before retrying.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transaction(async (session) => {
        const order = await OrderModel.findById(id).session(session);
        if (!order || order.status === "paid") return;
        if (order.amountKobo > 0) {
          if (!verification)
            throw new Error("Paid orders require provider verification.");
          if (
            verification.reference !== order.reference ||
            verification.amount !== order.amountKobo ||
            verification.currency !== "NGN"
          ) {
            await fail(
              order,
              session,
              "Rejected a payment reference, amount or currency mismatch.",
              verification.status === "success",
            );
            return;
          }
          if (verification.status !== "success") {
            if (
              verification.status === "failed" ||
              verification.status === "reversed"
            )
              await fail(
                order,
                session,
                "Paystack did not confirm a successful payment.",
              );
            else
              await paymentAudit(
                order,
                "payment.verification_failed",
                "Payment remains unconfirmed by Paystack; no tickets issued.",
                session,
              );
            return;
          }
          if (
            (typeof verification.id !== "string" &&
              !Number.isSafeInteger(verification.id)) ||
            !String(verification.id)
          ) {
            await fail(
              order,
              session,
              "Rejected an invalid provider transaction identifier.",
              true,
            );
            return;
          }
          const split =
            order.settlementMode === "test_unsplit"
              ? verifiedTestPayment(order, verification)
              : verifiedSplit(order, verification);
          if (!split) {
            await fail(
              order,
              session,
              order.settlementMode === "test_unsplit"
                ? "Rejected a test payment with an invalid environment or unexpected settlement allocation."
                : "Rejected a missing or mismatched settlement split. Manual reconciliation is required.",
              true,
            );
            return;
          }
          Object.assign(order, split);
          order.providerTransactionId = String(verification.id);
          order.verifiedAt = new Date();
          order.paidAt = verification.paid_at
            ? new Date(verification.paid_at)
            : undefined;
        } else order.paidAt = new Date();
        const hold = await SeatHoldModel.findById(order.holdId).session(
          session,
        );
        if (!hold) throw new Error("An order has no reservation record.");
        if (
          !order.paidAt ||
          Number.isNaN(order.paidAt.getTime()) ||
          order.paidAt.getTime() > Date.now() + 60000 ||
          order.paidAt > hold.expiresAt
        ) {
          await fail(
            order,
            session,
            "A payment arrived outside its reservation window; manual payment reconciliation is required.",
            order.amountKobo > 0,
          );
          return;
        }
        if (hold.state === "active" && hold.expiresAt.getTime() <= Date.now())
          await releaseHold(hold, session);
        const reserved = hold.state === "active";
        if (hold.state === "consumed")
          throw new Error("An unpaid order has a consumed reservation.");
        const quantity = hold.quantity;
        const types = [];
        for (const item of hold.items) {
          const type = await TicketTypeModel.findById(
            item.ticketTypeId,
          ).session(session);
          if (
            !type ||
            String(type.eventId) !== String(order.eventId) ||
            type.quantitySold +
              type.quantityHeld +
              (reserved ? 0 : item.quantity) >
              type.quantityLimit ||
            (reserved && type.quantityHeld < item.quantity)
          ) {
            await fail(
              order,
              session,
              "A verified payment could not be fulfilled: ticket allocation unavailable. Manual reconciliation is required.",
              order.amountKobo > 0,
            );
            return;
          }
          types.push(type);
        }
        const event = await EventModel.findOneAndUpdate(
          {
            _id: order.eventId,
            status: { $in: ["published", "sales_closed"] },
            startsAt: { $gt: new Date() },
            ...(reserved
              ? {
                  seatsHeld: { $gte: quantity },
                  $expr: {
                    $gte: [
                      inventoryLeft("capacity", "ticketsSold", "seatsHeld"),
                      0,
                    ],
                  },
                }
              : {
                  $expr: {
                    $gte: [
                      inventoryLeft("capacity", "ticketsSold", "seatsHeld"),
                      quantity,
                    ],
                  },
                }),
          },
          {
            $inc: {
              ticketsSold: quantity,
              seatsHeld: reserved ? -quantity : 0,
            },
          },
          { session, new: true },
        );
        if (!event) {
          await fail(
            order,
            session,
            "A verified payment could not be fulfilled: event unavailable or seats reallocated. Manual reconciliation is required.",
            order.amountKobo > 0,
          );
          return;
        }
        // The event write serializes issuances and edits. All type checks precede counter changes.
        for (const [index, item] of hold.items.entries()) {
          types[index].quantitySold += item.quantity;
          if (reserved) types[index].quantityHeld -= item.quantity;
          await types[index].save({ session });
        }
        hold.state = "consumed";
        await hold.save({ session });
        order.buyerUserId ??= await verifiedContactUser(
          order.buyer.email,
          order.buyer.phone,
          session,
        );
        let setupLink: string | undefined;
        if (
          order.createAccount &&
          !order.buyerUserId &&
          !(await UserModel.exists({ email: order.buyer.email }).session(
            session,
          ))
        ) {
          // No password was collected at checkout: create only an unverified account with an unknowable password.
          const passwordHash = await hashPassword(
            randomBytes(32).toString("hex"),
            12,
          );
          await UserModel.create(
            [
              {
                fullName: order.buyer.fullName,
                email: order.buyer.email,
                phone: order.buyer.phone,
                passwordHash,
                status: "unverified",
              },
            ],
            { session },
          );
          order.accountCreated = true;
          const link = new URL("/signup", ENV.CLIENT_URL);
          link.search = new URLSearchParams({
            name: order.buyer.fullName,
            email: order.buyer.email,
            phone: order.buyer.phone,
          }).toString();
          setupLink = link.toString();
        }
        const key = await eventSigningKey(event._id, session);
        const buyerLinks: string[] = [];
        const attendeeMail = new Map<string, string[]>();
        for (const [index, attendee] of order.attendees.entries()) {
          const code = ticketCode();
          const holderUserId = await verifiedContactUser(
            attendee.email,
            attendee.phone,
            session,
          );
          const line = order.lines.find(
            (item) =>
              String(item.ticketTypeId) === String(attendee.ticketTypeId),
          )!;
          const [ticket] = await TicketModel.create(
            [
              {
                code,
                eventId: event._id,
                ticketTypeId: attendee.ticketTypeId,
                orderId: order._id,
                attendeeIndex: index,
                holderUserId,
                holder: {
                  fullName: attendee.fullName,
                  email: attendee.email,
                  phone: attendee.phone,
                },
                ticketTypeName: line.ticketTypeName,
                pricePaidKobo: line.priceKobo,
                paymentId: order.reference,
                qrToken: signTicket(code, event.id, key.privateKey),
              },
            ],
            { session },
          );
          const link = await createGuestLink(ticket._id, code, session);
          buyerLinks.push(
            `${attendee.fullName} — ${line.ticketTypeName} — ${code}\n${link}`,
          );
          if (attendee.email && attendee.email !== order.buyer.email) {
            // Separate links: the buyer and attendee can each redeem their copy once.
            const ownLink = await createGuestLink(ticket._id, code, session);
            const own = attendeeMail.get(attendee.email) ?? [];
            own.push(`${attendee.fullName} — ${code}\n${ownLink}`);
            attendeeMail.set(attendee.email, own);
          }
        }
        const messages: TicketMail[] = [
          {
            to: order.buyer.email,
            subject: `Your HIP tickets: ${event.title}`,
            text: `${order.settlementMode === "test_unsplit" ? "TEST PAYMENT — no real money or bank settlement.\n" : ""}Payment confirmed. Reference: ${order.reference}\nTotal: NGN ${(order.amountKobo / 100).toFixed(2)}\n\n${buyerLinks.join("\n\n")}\n\nEach link works once and expires in 30 minutes. Find a fresh link at ${ENV.CLIENT_URL}/find-ticket.${setupLink ? `\nFinish creating your account and verify your email: ${setupLink}` : ""}`,
          },
        ];
        for (const [to, links] of attendeeMail)
          messages.push({
            to,
            subject: `Your HIP ticket: ${event.title}`,
            text: `${links.join("\n\n")}\nLinks expire in 30 minutes. Get a fresh link at ${ENV.CLIENT_URL}/find-ticket.`,
          });
        order.deliveryPayload = encrypt(
          JSON.stringify(messages),
          `hip:ticket-mail:${order.id}`,
        );
        order.deliveryState = "pending";
        order.status = "paid";
        order.failureReason = undefined;
        order.paymentReview = false;
        await order.save({ session });
        await paymentAudit(
          order,
          "order.paid",
          `${order.settlementMode === "test_unsplit" ? "TEST PAYMENT without bank settlement. " : ""}Issued ${quantity} tickets; subtotal ${order.subtotalKobo} kobo, fee ${order.feeKobo} kobo, total ${order.amountKobo} kobo.`,
          session,
        );
      });
    } catch (error) {
      if (
        error instanceof mongoose.mongo.MongoServerError &&
        error.code === 11000 &&
        error.keyPattern?.providerTransactionId
      ) {
        await transaction(async (session) => {
          const order = await OrderModel.findById(id).session(session);
          if (order && order.status !== "paid")
            await fail(
              order,
              session,
              "A provider transaction was already assigned to another order. Manual reconciliation is required.",
              true,
            );
        });
        return;
      }
      if (
        error instanceof mongoose.mongo.MongoServerError &&
        error.code === 11000 &&
        attempt < 2 &&
        (error.keyPattern?.code ||
          error.keyPattern?.eventId ||
          error.keyPattern?.email)
      )
        continue;
      throw error;
    }
  }
}
