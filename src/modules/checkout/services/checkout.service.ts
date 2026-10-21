import { createHash, randomBytes } from "crypto";
import mongoose, { Types } from "mongoose";
import { ENV } from "../../../config/env";
import { EventModel } from "../../../database/models/events.schema";
import {
  OrderModel,
  type OrderDocument,
} from "../../../database/models/orders.schema";
import { SeatHoldModel } from "../../../database/models/seat-hold.schema";
import { TicketTypeModel } from "../../../database/models/ticket-types.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { AppError } from "../../../shared/errors/app.error";
import { transaction } from "../../../shared/database/transaction";
import { decrypt, encrypt } from "../../../shared/security/encryption";
import {
  initializePayment,
  requirePaystack,
  verifyPayment,
  paystackDomain,
} from "../../../services/paystack.service";
import type { CheckoutRequest } from "../validators/checkout.validator";
import { type CheckoutViewer, viewerFilter } from "./checkout-access.service";
import { expireHolds, expiredHold, soldOut } from "./seat-hold.service";
import { settlementTotals } from "./fees";
import { settlementMode } from "./settlement-mode";
import { settings } from "../../admin/services/checkout-settings.service";
import { confirmOrder } from "./payment-confirmation.service";
import { paymentAudit } from "./payment-audit.service";
import { deliverOrderMail } from "./checkout-mail.service";
import { ticketDetails } from "../../tickets/services/ticket-response";

const missing = () => new AppError(404, "not_found", "Checkout not found");
const requestHash = (input: CheckoutRequest) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
const sameItems = (
  a: { ticketTypeId: Types.ObjectId | string; quantity: number }[],
  b: { ticketTypeId: Types.ObjectId | string; quantity: number }[],
) =>
  JSON.stringify(
    a.map((item) => [String(item.ticketTypeId), item.quantity]),
  ) ===
  JSON.stringify(b.map((item) => [String(item.ticketTypeId), item.quantity]));

async function ownedOrder(id: string, viewer: CheckoutViewer) {
  const order = await OrderModel.findOne({ _id: id, ...viewerFilter(viewer) });
  if (!order) throw missing();
  return order;
}
function checkoutResponse(order: OrderDocument, accessCode?: string) {
  return {
    checkoutId: order.id as string,
    reference: order.reference,
    ...(accessCode ? { paystackAccessCode: accessCode } : {}),
    ...(order.settlementMode === "test_unsplit"
      ? { settlementMode: "test_unsplit" as const }
      : {}),
    amountKobo: order.amountKobo,
    feeBreakdown: order.feeBreakdown ?? null,
  };
}
async function initialize(order: OrderDocument) {
  if (order.amountKobo === 0) {
    await confirmOrder(order.id);
    await deliverOrderMail(order.id);
    return checkoutResponse(order);
  }
  if (
    !order.feeBreakdown ||
    (order.settlementMode === "test_unsplit"
      ? paystackDomain() !== "test" || order.settlementDomain !== "test"
      : !order.subaccountCode ||
        order.transactionChargeKobo === undefined ||
        !order.settlementBearer) ||
    order.settlementDomain !== paystackDomain()
  )
    throw new AppError(
      409,
      "settlement_setup_required",
      "This payment session predates settlement setup. Start a new checkout.",
    );
  const hold = await SeatHoldModel.findById(order.holdId);
  if (
    !hold ||
    hold.state !== "active" ||
    hold.expiresAt.getTime() <= Date.now()
  )
    throw expiredHold();
  const current = await OrderModel.findById(order._id).select("+accessCode");
  if (current?.accessCode)
    return checkoutResponse(
      order,
      decrypt(current.accessCode, `hip:paystack:${order.id}`),
    );
  requirePaystack();
  const until = new Date(Date.now() + 30000);
  const claimed = await OrderModel.findOneAndUpdate(
    {
      _id: order._id,
      status: "pending",
      accessCode: { $exists: false },
      $or: [
        { initializeLeaseUntil: { $exists: false } },
        { initializeLeaseUntil: { $lte: new Date() } },
      ],
    },
    { $set: { initializeLeaseUntil: until } },
  );
  if (!claimed)
    throw new AppError(
      409,
      "payment_initializing",
      "Your payment session is being prepared. Please try again shortly.",
    );
  try {
    const callback = new URL(`/checkout/${order.eventId}`, ENV.CLIENT_URL);
    callback.searchParams.set("checkout", order.id);
    callback.searchParams.set(
      "items",
      order.lines
        .map((line) => `${line.ticketTypeId}:${line.quantity}`)
        .join(","),
    );
    // Never run provider calls inside MongoDB's retryable transaction callback.
    const accessCode = await initializePayment({
      reference: order.reference,
      amountKobo: order.amountKobo,
      email: order.buyer.email,
      channel: order.paymentChannel,
      callbackUrl: callback.toString(),
      ...(order.settlementMode === "test_unsplit"
        ? { settlementMode: "test_unsplit" as const }
        : {
            subaccountCode: order.subaccountCode!,
            transactionChargeKobo: order.transactionChargeKobo!,
            bearer: order.settlementBearer!,
          }),
    });
    const saved = await OrderModel.updateOne(
      { _id: order._id, initializeLeaseUntil: until },
      {
        $set: { accessCode: encrypt(accessCode, `hip:paystack:${order.id}`) },
        $unset: { initializeLeaseUntil: 1 },
      },
    );
    if (!saved.modifiedCount)
      throw new AppError(
        409,
        "payment_initializing",
        "Please try reopening your payment session.",
      );
    if (hold.expiresAt.getTime() <= Date.now()) throw expiredHold();
    return checkoutResponse(order, accessCode);
  } catch (error) {
    await OrderModel.updateOne(
      { _id: order._id, initializeLeaseUntil: until },
      { $unset: { initializeLeaseUntil: 1 } },
    );
    // The stable reference is retained after an ambiguous network result. Never start a second charge.
    throw error;
  }
}
export async function startCheckout(
  input: CheckoutRequest,
  viewer: CheckoutViewer,
) {
  await expireHolds(input.eventId);
  let order: OrderDocument | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      order = await transaction(async (session) => {
        const hold = await SeatHoldModel.findOne({
          _id: input.holdId,
          ...viewerFilter(viewer),
        })
          .select("+ownerHash")
          .session(session);
        if (!hold) throw expiredHold();
        if (
          String(hold.eventId) !== input.eventId ||
          !sameItems(hold.items, input.items)
        )
          throw new AppError(
            400,
            "hold_mismatch",
            "Your ticket selection does not match the seat hold.",
            { field: "items" },
          );
        const existing = await OrderModel.findOne({ holdId: hold._id })
          .select("+requestHash")
          .session(session);
        if (existing) {
          if (
            existing.status !== "paid" &&
            (hold.state !== "active" || hold.expiresAt.getTime() <= Date.now())
          )
            throw expiredHold();
          if (existing.requestHash !== requestHash(input))
            throw new AppError(
              409,
              "hold_in_use",
              "This seat hold already has an order. Resume that order or start again.",
            );
          return existing;
        }
        if (hold.state !== "active" || hold.expiresAt.getTime() <= Date.now())
          throw expiredHold();
        const now = new Date();
        const event = await EventModel.findOneAndUpdate(
          {
            _id: hold.eventId,
            status: "published",
            startsAt: { $gt: now },
            registrationDeadline: { $gt: now },
          },
          { $inc: { __v: 1 } },
          { new: true, session },
        );
        if (!event) throw soldOut();
        const lines = [];
        for (const item of hold.items) {
          const type = await TicketTypeModel.findOne({
            _id: item.ticketTypeId,
            eventId: hold.eventId,
            status: "active",
            salesStart: { $lte: now },
            salesEnd: { $gte: now },
          }).session(session);
          if (!type) throw soldOut();
          lines.push({
            ticketTypeId: type._id,
            ticketTypeName: type.name,
            quantity: item.quantity,
            priceKobo: type.priceKobo,
          });
        }
        const subtotal = lines.reduce(
          (sum, line) => sum + BigInt(line.priceKobo) * BigInt(line.quantity),
          BigInt(0),
        );
        if (subtotal > BigInt(Number.MAX_SAFE_INTEGER))
          throw new AppError(
            422,
            "amount_too_large",
            "This order amount is too large. Contact the group.",
            { field: "items" },
          );
        const policy = await settings(session);
        const breakdown = settlementTotals(lines, policy);
        const mode =
          breakdown.totalKobo > 0 ? settlementMode(policy) : undefined;
        const totals = {
          subtotalKobo: breakdown.subtotalKobo,
          feeKobo: breakdown.paystackFeeKobo,
          amountKobo: breakdown.totalKobo,
          feeBreakdown: breakdown,
          groupNetKobo: breakdown.groupNetKobo,
          ...(breakdown.totalKobo > 0
            ? {
                settlementMode: mode,
                settlementDomain: policy.providerDomain,
                ...(mode === "split"
                  ? {
                      subaccountCode: policy.subaccountCode,
                      transactionChargeKobo:
                        breakdown.platformFeeKobo +
                        breakdown.buyerPaystackFeeKobo,
                      settlementBearer:
                        policy.paystackFeeBearer === "hiker"
                          ? "account"
                          : "subaccount",
                    }
                  : {}),
              }
            : {}),
        };
        const [created] = await OrderModel.create(
          [
            {
              holdId: hold._id,
              eventId: hold.eventId,
              ownerHash: hold.ownerHash,
              requestHash: requestHash(input),
              buyerUserId: viewer.userId,
              buyer: input.buyer,
              attendees: input.attendees,
              emergencyContact: input.emergencyContact,
              createAccount: !viewer.userId && input.createAccount,
              isGuest: !viewer.userId,
              whatsappReminders: input.whatsappReminders,
              paymentChannel: input.paymentChannel,
              lines,
              ...totals,
              reference: `HIP-${randomBytes(16).toString("hex")}`,
            },
          ],
          { session },
        );
        hold.orderId = created._id;
        await hold.save({ session });
        return created;
      });
      break;
    } catch (error) {
      if (
        error instanceof mongoose.mongo.MongoServerError &&
        error.code === 11000 &&
        error.keyPattern?.holdId &&
        attempt < 2
      )
        continue;
      throw error;
    }
  }
  if (!order)
    throw new AppError(409, "conflict", "Please try starting checkout again.");
  if (order.status === "paid") return checkoutResponse(order);
  if (order.status === "failed")
    throw new AppError(
      409,
      "payment_failed",
      order.failureReason ?? "Please start checkout again.",
    );
  return initialize(order);
}
export async function resumeCheckout(id: string, viewer: CheckoutViewer) {
  const order = await ownedOrder(id, viewer);
  await expireHolds(order.eventId.toString());
  if (order.status === "paid")
    throw new AppError(
      409,
      "already_paid",
      "This order is already paid. Open your tickets.",
    );
  const hold = await SeatHoldModel.findById(order.holdId);
  if (
    !hold ||
    hold.state !== "active" ||
    hold.expiresAt.getTime() <= Date.now()
  )
    throw expiredHold();
  if (order.status === "failed")
    throw new AppError(409, "payment_failed", "Please start checkout again.");
  return initialize(order);
}
export async function checkPayment(order: OrderDocument) {
  if (order.status === "paid") return;
  if (order.amountKobo === 0) {
    await confirmOrder(order.id);
    return;
  }
  let verification;
  try {
    verification = await verifyPayment(order.reference);
  } catch (error) {
    await transaction(async (session) => {
      const current = await OrderModel.findById(order._id).session(session);
      if (current)
        await paymentAudit(
          current,
          "payment.verification_failed",
          "Paystack verification was unavailable; no tickets were issued by this attempt.",
          session,
        );
    });
    throw error;
  }
  await confirmOrder(order.id, verification);
}
export async function checkoutStatus(id: string, viewer: CheckoutViewer) {
  const order = await ownedOrder(id, viewer);
  await expireHolds(order.eventId.toString());
  await checkPayment(order);
  await deliverOrderMail(order.id);
  const current = (await OrderModel.findById(order._id))!;
  const event = await EventModel.findById(current.eventId);
  if (!event) throw missing();
  const tickets =
    current.status === "paid"
      ? await TicketModel.find({ orderId: current._id }).sort({
          attendeeIndex: 1,
        })
      : [];
  return {
    status: current.status,
    reference: current.reference,
    ...(current.settlementMode === "test_unsplit"
      ? { settlementMode: "test_unsplit" as const }
      : {}),
    amountKobo: current.amountKobo,
    feeBreakdown: current.feeBreakdown ?? null,
    isGuest: current.isGuest,
    buyer: {
      fullName: current.buyer.fullName,
      email: current.buyer.email,
      phone: current.buyer.phone,
    },
    accountCreated: current.accountCreated,
    tickets: tickets.map((ticket) => ticketDetails(ticket, event)),
    ...(current.failureReason ? { failureReason: current.failureReason } : {}),
  };
}
export async function webhookPayment(reference: string) {
  const order = await OrderModel.findOne({ reference });
  if (!order) return;
  // A signed webhook is only a trigger. Provider verification, not its posted amount/status, decides issuance.
  await expireHolds(order.eventId.toString());
  await checkPayment(order);
  await deliverOrderMail(order.id);
}

// A quote does not reserve inventory. Checkout always recalculates and freezes its own prices.
export async function quote(input: {
  eventId: string;
  items: { ticketTypeId: string; quantity: number }[];
}) {
  const now = new Date();
  const event = await EventModel.findOne({
    _id: input.eventId,
    status: "published",
    startsAt: { $gt: now },
    registrationDeadline: { $gt: now },
  });
  if (!event) throw soldOut();
  const lines = [];
  for (const item of input.items) {
    const type = await TicketTypeModel.findOne({
      _id: item.ticketTypeId,
      eventId: event._id,
      status: "active",
      salesStart: { $lte: now },
      salesEnd: { $gte: now },
    });
    if (!type) throw soldOut();
    lines.push({ priceKobo: type.priceKobo, quantity: item.quantity });
  }
  const policy = await settings();
  const feeBreakdown = settlementTotals(lines, policy);
  const mode = feeBreakdown.totalKobo > 0 ? settlementMode(policy) : undefined;
  return {
    amountKobo: feeBreakdown.totalKobo,
    feeBreakdown,
    ...(mode === "test_unsplit"
      ? { settlementMode: "test_unsplit" as const }
      : {}),
  };
}
