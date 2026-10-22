import mongoose, { Schema, Types } from "mongoose";

// First admissions only. Controller 8 will add device synchronization and re-entry handling.
export interface ICheckIn {
  ticket: Types.ObjectId;
  event: Types.ObjectId;
  user?: Types.ObjectId;
  checkedInAt: Date;
  method: "qr" | "qr_offline" | "manual";
  deviceId?: string;
  synced: boolean;
}
const schema = new Schema<ICheckIn>(
  {
    ticket: {
      type: Schema.Types.ObjectId,
      ref: "Ticket",
      required: true,
      unique: true,
    },
    event: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    checkedInAt: { type: Date, required: true },
    method: {
      type: String,
      enum: ["qr", "qr_offline", "manual"],
      required: true,
    },
    deviceId: String,
    synced: { type: Boolean, default: true },
  },
  { versionKey: false },
);
schema.index({ user: 1, checkedInAt: -1 });
export const CheckInModel = mongoose.model<ICheckIn>("CheckIn", schema);
