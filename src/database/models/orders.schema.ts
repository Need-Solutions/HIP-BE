import mongoose, { Schema, Types } from "mongoose";
import type { FeeBreakdown } from "../../modules/checkout/services/fees";

export interface Contact {
  fullName: string;
  email: string;
  phone: string;
}
export interface Attendee {
  ticketTypeId: Types.ObjectId;
  fullName: string;
  email?: string;
  phone?: string;
}
export interface OrderLine {
  ticketTypeId: Types.ObjectId;
  ticketTypeName: string;
  quantity: number;
  priceKobo: number;
}
export interface IOrder {
  holdId: Types.ObjectId;
  eventId: Types.ObjectId;
  ownerHash: string;
  requestHash: string;
  buyerUserId?: Types.ObjectId;
  buyer: Contact;
  attendees: Attendee[];
  emergencyContact: { name: string; phone: string };
  lines: OrderLine[];
  createAccount: boolean;
  accountCreated: boolean;
  isGuest: boolean;
  whatsappReminders: boolean;
  paymentChannel: "card" | "bank_transfer" | "ussd";
  subtotalKobo: number;
  feeKobo: number;
  feeBreakdown?: FeeBreakdown;
  subaccountCode?: string;
  settlementDomain?: "test" | "live";
  settlementMode?: "split" | "test_unsplit";
  transactionChargeKobo?: number;
  settlementBearer?: "account" | "subaccount";
  groupNetKobo?: number;
  actualPaystackFeeKobo?: number;
  actualGroupNetKobo?: number;
  actualPlatformNetKobo?: number;
  splitVerifiedAt?: Date;
  amountKobo: number;
  currency: "NGN";
  reference: string;
  status: "pending" | "paid" | "failed";
  failureReason?: string;
  paymentReview: boolean;
  providerTransactionId?: string;
  verifiedAt?: Date;
  paidAt?: Date;
  accessCode?: string;
  initializeLeaseUntil?: Date;
  deliveryPayload?: string;
  deliveryState: "none" | "pending" | "sent";
  deliveryLeaseUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}
const contact = {
  fullName: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
};
const schema = new Schema<IOrder>(
  {
    holdId: {
      type: Schema.Types.ObjectId,
      ref: "SeatHold",
      required: true,
      unique: true,
    },
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    ownerHash: { type: String, required: true, select: false },
    requestHash: { type: String, required: true, select: false },
    buyerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    buyer: { type: new Schema(contact, { _id: false }), required: true },
    attendees: [
      {
        _id: false,
        ticketTypeId: { type: Schema.Types.ObjectId, required: true },
        fullName: { type: String, required: true },
        email: String,
        phone: String,
      },
    ],
    emergencyContact: { name: String, phone: String },
    lines: [
      {
        _id: false,
        ticketTypeId: { type: Schema.Types.ObjectId, required: true },
        ticketTypeName: String,
        quantity: Number,
        priceKobo: Number,
      },
    ],
    createAccount: { type: Boolean, default: false },
    accountCreated: { type: Boolean, default: false },
    isGuest: { type: Boolean, required: true },
    whatsappReminders: { type: Boolean, default: false },
    paymentChannel: {
      type: String,
      enum: ["card", "bank_transfer", "ussd"],
      required: true,
    },
    subtotalKobo: { type: Number, required: true },
    feeKobo: { type: Number, required: true },
    feeBreakdown: {
      type: new Schema(
        {
          platformFeePercent: Number,
          platformFeeMode: String,
          platformFeeOnRefund: String,
          paystackFeeBearer: String,
          subtotalKobo: Number,
          paystackFeeKobo: Number,
          platformFeeKobo: Number,
          buyerPaystackFeeKobo: Number,
          buyerPlatformFeeKobo: Number,
          groupNetKobo: Number,
          totalKobo: Number,
        },
        { _id: false },
      ),
      default: undefined,
    },
    subaccountCode: String,
    settlementDomain: { type: String, enum: ["test", "live"] },
    settlementMode: { type: String, enum: ["split", "test_unsplit"] },
    transactionChargeKobo: Number,
    settlementBearer: { type: String, enum: ["account", "subaccount"] },
    groupNetKobo: Number,
    actualPaystackFeeKobo: Number,
    actualGroupNetKobo: Number,
    actualPlatformNetKobo: Number,
    splitVerifiedAt: Date,
    amountKobo: { type: Number, required: true },
    currency: { type: String, enum: ["NGN"], default: "NGN" },
    reference: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
    },
    failureReason: String,
    paymentReview: { type: Boolean, default: false },
    providerTransactionId: String,
    verifiedAt: Date,
    paidAt: Date,
    accessCode: { type: String, select: false },
    initializeLeaseUntil: Date,
    deliveryPayload: { type: String, select: false },
    deliveryState: {
      type: String,
      enum: ["none", "pending", "sent"],
      default: "none",
    },
    deliveryLeaseUntil: Date,
  },
  { timestamps: true },
);
schema.index({ status: 1, paidAt: 1 });
schema.index({ eventId: 1, status: 1 });
schema.index({ deliveryState: 1, deliveryLeaseUntil: 1 });
schema.index({ "buyer.email": 1 });
schema.index({ "buyer.phone": 1 });
schema.index({ providerTransactionId: 1 }, { unique: true, sparse: true });
export const OrderModel = mongoose.model<IOrder>("Order", schema);
export type OrderDocument = mongoose.HydratedDocument<IOrder>;
