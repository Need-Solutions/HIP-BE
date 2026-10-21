import { type ClientSession, Types } from "mongoose";
import { EventModel } from "../../../database/models/events.schema";
import { TicketTypeModel } from "../../../database/models/ticket-types.schema";
import {
  SeatHoldModel,
  type SeatHoldDocument,
} from "../../../database/models/seat-hold.schema";
import { AppError } from "../../../shared/errors/app.error";
import { transaction } from "../../../shared/database/transaction";
import type { HoldRequest } from "../validators/checkout.validator";
import type { CheckoutViewer } from "./checkout-access.service";

export const HOLD_MS = 10 * 60000;
export const expiredHold = () =>
  new AppError(
    410,
    "hold_expired",
    "Your seat hold has expired. Please start again.",
  );
export const soldOut = () =>
  new AppError(
    409,
    "sold_out",
    "Those tickets are sold out or no longer on sale.",
  );
export const inventoryLeft = (limit: string, sold: string, held: string) => ({
  $subtract: [
    `$${limit}`,
    { $add: [{ $ifNull: [`$${sold}`, 0] }, { $ifNull: [`$${held}`, 0] }] },
  ],
});

export async function releaseHold(
  hold: SeatHoldDocument,
  session: ClientSession,
) {
  const claimed = await SeatHoldModel.updateOne(
    { _id: hold._id, state: "active" },
    { $set: { state: "expired" } },
    { session },
  );
  if (!claimed.modifiedCount) return;
  const event = await EventModel.updateOne(
    { _id: hold.eventId, seatsHeld: { $gte: hold.quantity } },
    { $inc: { seatsHeld: -hold.quantity } },
    { session },
  );
  if (event.modifiedCount !== 1)
    throw new Error("Event reservation counters are inconsistent.");
  for (const item of hold.items) {
    const type = await TicketTypeModel.updateOne(
      {
        _id: item.ticketTypeId,
        eventId: hold.eventId,
        quantityHeld: { $gte: item.quantity },
      },
      { $inc: { quantityHeld: -item.quantity } },
      { session },
    );
    if (type.modifiedCount !== 1)
      throw new Error("Ticket reservation counters are inconsistent.");
  }
  hold.state = "expired";
}
export async function expireHolds(eventId?: string) {
  // Bounded batches; expiry is also enforced on every inventory read/write, independent of the timer.
  for (;;) {
    const expired = await SeatHoldModel.find({
      state: "active",
      expiresAt: { $lte: new Date() },
      ...(eventId ? { eventId } : {}),
    })
      .limit(100)
      .select("_id");
    for (const item of expired)
      await transaction(async (session) => {
        const hold = await SeatHoldModel.findOne({
          _id: item._id,
          state: "active",
          expiresAt: { $lte: new Date() },
        }).session(session);
        if (hold) await releaseHold(hold, session);
      });
    if (expired.length < 100) return;
  }
}
export async function holdSeats(input: HoldRequest, viewer: CheckoutViewer) {
  await expireHolds(input.eventId);
  const quantity = input.items.reduce((sum, item) => sum + item.quantity, 0);
  return transaction(async (session) => {
    const now = new Date();
    const event = await EventModel.findOneAndUpdate(
      {
        _id: input.eventId,
        status: "published",
        startsAt: { $gt: now },
        registrationDeadline: { $gt: now },
        $expr: {
          $gte: [
            inventoryLeft("capacity", "ticketsSold", "seatsHeld"),
            quantity,
          ],
        },
      },
      { $inc: { seatsHeld: quantity } },
      { new: true, session },
    );
    if (!event) throw soldOut();
    for (const item of input.items) {
      const type = await TicketTypeModel.findOneAndUpdate(
        {
          _id: item.ticketTypeId,
          eventId: input.eventId,
          status: "active",
          salesStart: { $lte: now },
          salesEnd: { $gte: now },
          $expr: {
            $gte: [
              inventoryLeft("quantityLimit", "quantitySold", "quantityHeld"),
              item.quantity,
            ],
          },
        },
        { $inc: { quantityHeld: item.quantity } },
        { new: true, session },
      );
      if (!type) throw soldOut();
    }
    const [hold] = await SeatHoldModel.create(
      [
        {
          eventId: event._id,
          ownerHash: viewer.ownerHash,
          buyerUserId: viewer.userId
            ? new Types.ObjectId(viewer.userId)
            : undefined,
          items: input.items,
          quantity,
          expiresAt: new Date(now.getTime() + HOLD_MS),
        },
      ],
      { session },
    );
    return {
      holdId: hold.id as string,
      expiresAt: hold.expiresAt.toISOString(),
    };
  });
}
