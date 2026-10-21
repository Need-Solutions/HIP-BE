import type { ClientSession } from "mongoose";
import {
  AuditLogModel,
  type IAuditLog,
} from "../../../database/models/audit-log.schema";
import type { AdminDocument } from "../../../database/models/admin.schema";

// No update/delete methods: a caller must share the transaction that changes the target.
export const recordAudit = async (
  actor: AdminDocument,
  entry: Pick<IAuditLog, "action" | "target" | "details" | "reason">,
  session: ClientSession,
) =>
  appendAudit(
    { id: actor.id, name: actor.fullName, role: actor.role },
    entry,
    session,
  );

export const appendAudit = async (
  actor: IAuditLog["actor"],
  entry: Pick<IAuditLog, "action" | "target" | "details" | "reason">,
  session: ClientSession,
) => {
  if (!session.inTransaction())
    throw new Error("Audit entries require a transaction.");
  await AuditLogModel.create(
    [
      {
        ...entry,
        actor,
      },
    ],
    { session },
  );
};
