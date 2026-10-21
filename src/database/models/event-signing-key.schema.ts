import mongoose, { Schema, Types } from "mongoose";

export interface IEventSigningKey {
  eventId: Types.ObjectId;
  publicKeyJwk: { kty: string; crv: string; x: string; y: string };
  privateKey: string;
}
const schema = new Schema<IEventSigningKey>(
  {
    eventId: { type: Schema.Types.ObjectId, required: true, unique: true },
    publicKeyJwk: { type: Schema.Types.Mixed, required: true },
    privateKey: { type: String, required: true, select: false },
  },
  { timestamps: true },
);
export const EventSigningKeyModel = mongoose.model<IEventSigningKey>(
  "EventSigningKey",
  schema,
);
