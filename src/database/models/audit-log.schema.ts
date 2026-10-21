import mongoose, { Schema } from "mongoose";
import { AdminRole } from "./admin.schema";

export type AuditRole = AdminRole | "hiker" | "guest" | "system";
export interface IAuditLog {
  actor: { id: string; name: string; role: AuditRole };
  action: string;
  target: {
    type: "staff" | "staff_invite" | "event" | "checkout" | "checkout_settings";
    id: string;
  };
  details: string;
  reason?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actor: {
      id: { type: String, required: true },
      name: { type: String, required: true },
      role: {
        type: String,
        enum: [...Object.values(AdminRole), "hiker", "guest", "system"],
        required: true,
      },
    },
    action: { type: String, required: true },
    target: {
      type: {
        type: String,
        enum: [
          "staff",
          "staff_invite",
          "event",
          "checkout",
          "checkout_settings",
        ],
        required: true,
      },
      id: { type: String, required: true },
    },
    details: { type: String, required: true },
    reason: String,
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false },
);

const immutable = () => {
  throw new Error("Audit entries cannot be updated or deleted.");
};
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.pre("save", function () {
  if (!this.isNew) immutable();
});
AuditLogSchema.pre(
  [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "findOneAndReplace",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
  ],
  immutable,
);
AuditLogSchema.pre("deleteOne", { document: true, query: false }, immutable);
AuditLogSchema.pre("bulkWrite", immutable);
AuditLogSchema.pre("aggregate", function () {
  if (this.pipeline().some((stage) => "$merge" in stage || "$out" in stage))
    immutable();
});

export const AuditLogModel = mongoose.model<IAuditLog>(
  "AuditLog",
  AuditLogSchema,
);
