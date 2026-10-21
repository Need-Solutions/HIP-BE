import mongoose, { Schema, Types } from "mongoose";

export interface IGuestTicketLink {
  ticketId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  browserHash?: string;
  accessExpiresAt?: Date;
}
const schema = new Schema<IGuestTicketLink>({
  ticketId: { type: Schema.Types.ObjectId, ref: "Ticket", required: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true },
  usedAt: Date,
  browserHash: { type: String, select: false },
  accessExpiresAt: Date,
});
schema.index({ ticketId: 1, browserHash: 1, accessExpiresAt: 1 });
export const GuestTicketLinkModel = mongoose.model<IGuestTicketLink>(
  "GuestTicketLink",
  schema,
);
