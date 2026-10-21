import mongoose, { Schema } from "mongoose";

export interface FeePolicy {
  platformFeePercent?: number;
  platformFeeMode: "added_to_buyer" | "deducted_from_group";
  platformFeeOnRefund: "refund" | "keep";
  paystackFeeBearer: "hiker" | "group";
}
export interface ICheckoutSettings extends FeePolicy {
  _id: string;
  subaccountCode?: string;
  localTestOnly?: boolean;
  providerDomain?: "test" | "live";
  bankCode?: string;
  accountName?: string;
  accountVerified?: boolean;
  accountLast4?: string;
  accountFingerprint?: string;
  setupLeaseUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<ICheckoutSettings>(
  {
    _id: { type: String },
    platformFeePercent: { type: Number, min: 0.01, max: 100 },
    platformFeeMode: {
      type: String,
      enum: ["added_to_buyer", "deducted_from_group"],
      required: true,
    },
    platformFeeOnRefund: {
      type: String,
      enum: ["refund", "keep"],
      required: true,
    },
    paystackFeeBearer: {
      type: String,
      enum: ["hiker", "group"],
      required: true,
    },
    subaccountCode: String,
    localTestOnly: Boolean,
    providerDomain: { type: String, enum: ["test", "live"] },
    bankCode: String,
    accountName: String,
    accountVerified: Boolean,
    accountLast4: String,
    accountFingerprint: { type: String, select: false },
    setupLeaseUntil: { type: Date, select: false },
  },
  { timestamps: true },
);
export const CheckoutSettingsModel = mongoose.model<ICheckoutSettings>(
  "CheckoutSettings",
  schema,
);
