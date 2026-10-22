import mongoose, { Schema, Types } from "mongoose";

export interface ITicket {
  code: string;
  eventId: Types.ObjectId;
  ticketTypeId: Types.ObjectId;
  orderId: Types.ObjectId;
  attendeeIndex: number;
  holderUserId?: Types.ObjectId;
  holder: { fullName: string; email?: string; phone?: string };
  ticketTypeName: string;
  pricePaidKobo: number;
  paymentId: string;
  qrToken: string;
  status:
    | "confirmed"
    | "refund_pending"
    | "checked_in"
    | "cancelled"
    | "refunded"
    | "expired";
  issuedAt: Date;
}
const schema = new Schema<ITicket>(
  {
    code: { type: String, required: true, unique: true },
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    ticketTypeId: {
      type: Schema.Types.ObjectId,
      ref: "TicketType",
      required: true,
    },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    attendeeIndex: { type: Number, required: true },
    holderUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    holder: {
      fullName: { type: String, required: true },
      email: String,
      phone: String,
    },
    ticketTypeName: { type: String, required: true },
    pricePaidKobo: { type: Number, required: true },
    paymentId: { type: String, required: true },
    qrToken: { type: String, required: true },
    status: {
      type: String,
      enum: [
        "confirmed",
        "refund_pending",
        "checked_in",
        "cancelled",
        "refunded",
        "expired",
      ],
      default: "confirmed",
    },
    issuedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
schema.index({ orderId: 1, attendeeIndex: 1 }, { unique: true });
schema.index({ "holder.email": 1 });
schema.index({ "holder.phone": 1 });
export const TicketModel = mongoose.model<ITicket>("Ticket", schema);
export type TicketDocument = mongoose.HydratedDocument<ITicket>;
