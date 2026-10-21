import mongoose, { Schema, Types } from "mongoose";

export interface ITicketType {
  eventId: Types.ObjectId;
  name: string;
  description: string;
  priceKobo: number;
  currency: "NGN";
  quantityLimit: number;
  quantitySold: number;
  quantityHeld: number;
  salesStart: Date;
  salesEnd: Date;
  status: "active" | "paused" | "sold_out";
  position: number;
}
const schema = new Schema<ITicketType>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    priceKobo: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ["NGN"], default: "NGN" },
    quantityLimit: { type: Number, required: true, min: 1, max: 10000 },
    quantitySold: { type: Number, min: 0, default: 0 },
    quantityHeld: { type: Number, min: 0, default: 0 },
    salesStart: { type: Date, required: true },
    salesEnd: { type: Date, required: true },
    status: {
      type: String,
      enum: ["active", "paused", "sold_out"],
      default: "active",
    },
    position: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const TicketTypeModel = mongoose.model<ITicketType>(
  "TicketType",
  schema,
);
export type TicketTypeDocument = mongoose.HydratedDocument<ITicketType>;
