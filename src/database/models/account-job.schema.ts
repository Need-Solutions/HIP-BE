import mongoose, { Schema } from "mongoose";

// Durable notifications/asset cleanup. Email addresses and message bodies are encrypted and erased on success.
const schema = new Schema(
  {
    kind: { type: String, enum: ["mail", "remove_photo"], required: true },
    payload: { type: String, required: true, select: false },
    state: { type: String, enum: ["pending", "done"], default: "pending" },
    retryAt: { type: Date, default: Date.now },
    leaseUntil: Date,
  },
  { timestamps: true },
);
schema.index({ state: 1, retryAt: 1 });
export const AccountJobModel = mongoose.model("AccountJob", schema);
