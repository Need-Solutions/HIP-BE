import mongoose, { Schema, Types } from "mongoose";

export interface RefundBreakdown {
  ticketSubtotalKobo: number;
  ticketRefundKobo: number;
  platformFeeKobo: number;
  platformFeeRefundedKobo: number;
  paystackFeeRefundedKobo: number;
  totalRefundKobo: number;
  platformFeeOnRefund: "refund" | "keep";
  platformFeeMode: "added_to_buyer" | "deducted_from_group";
}
export interface IRefundRequest {
  ticket: Types.ObjectId;
  user: Types.ObjectId;
  order: Types.ObjectId;
  amountKobo: number;
  percent: 100 | 50;
  feeBreakdown: RefundBreakdown;
  reason: string;
  note?: string;
  status: "pending" | "approved" | "rejected" | "paid";
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<IRefundRequest>(
  {
    ticket: {
      type: Schema.Types.ObjectId,
      ref: "Ticket",
      required: true,
      unique: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    amountKobo: { type: Number, required: true, min: 0 },
    percent: { type: Number, enum: [100, 50], required: true },
    feeBreakdown: {
      type: new Schema<RefundBreakdown>(
        {
          ticketSubtotalKobo: Number,
          ticketRefundKobo: Number,
          platformFeeKobo: Number,
          platformFeeRefundedKobo: Number,
          paystackFeeRefundedKobo: Number,
          totalRefundKobo: Number,
          platformFeeOnRefund: { type: String, enum: ["refund", "keep"] },
          platformFeeMode: {
            type: String,
            enum: ["added_to_buyer", "deducted_from_group"],
          },
        },
        { _id: false },
      ),
      required: true,
    },
    reason: { type: String, required: true, maxlength: 500 },
    note: { type: String, maxlength: 1000 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "paid"],
      default: "pending",
    },
  },
  { timestamps: true },
);
export const RefundRequestModel = mongoose.model<IRefundRequest>(
  "RefundRequest",
  schema,
);
export type RefundDocument = mongoose.HydratedDocument<IRefundRequest>;
