import mongoose, { Schema, Types } from "mongoose";

export interface HoldItem {
  ticketTypeId: Types.ObjectId;
  quantity: number;
}
export interface ISeatHold {
  eventId: Types.ObjectId;
  ownerHash: string;
  buyerUserId?: Types.ObjectId;
  items: HoldItem[];
  quantity: number;
  expiresAt: Date;
  state: "active" | "expired" | "consumed";
  orderId?: Types.ObjectId;
}
const schema = new Schema<ISeatHold>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    ownerHash: { type: String, required: true, select: false },
    buyerUserId: { type: Schema.Types.ObjectId, ref: "User" },
    items: [
      {
        _id: false,
        ticketTypeId: { type: Schema.Types.ObjectId, required: true },
        quantity: { type: Number, required: true },
      },
    ],
    quantity: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    state: {
      type: String,
      enum: ["active", "expired", "consumed"],
      default: "active",
    },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
  },
  { timestamps: true },
);
// Never TTL-delete a live reservation: its counters must be released in a transaction first.
schema.index({ state: 1, expiresAt: 1, eventId: 1 });
export const SeatHoldModel = mongoose.model<ISeatHold>("SeatHold", schema);
export type SeatHoldDocument = mongoose.HydratedDocument<ISeatHold>;
