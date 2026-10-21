import type { ClientSession } from "mongoose";
import type { OrderDocument } from "../../../database/models/orders.schema";
import { appendAudit } from "../../admin/services/audit-log.service";
import { transaction } from "../../../shared/database/transaction";

export const paymentAudit = (
  order: OrderDocument,
  action: string,
  reason: string,
  session: ClientSession,
) =>
  appendAudit(
    {
      id: order.buyerUserId?.toString() ?? "guest",
      name: order.buyerUserId ? "Hiker" : "Guest checkout",
      role: order.buyerUserId ? "hiker" : "guest",
    },
    {
      action,
      target: { type: "checkout", id: order.id },
      details: `${order.reference}: ${reason}`,
    },
    session,
  );
export const invalidWebhookAudit = () =>
  transaction((session) =>
    appendAudit(
      { id: "paystack", name: "Payment verification", role: "system" },
      {
        action: "payment.verification_failed",
        target: { type: "checkout", id: "paystack-webhook" },
        details: "Rejected an invalid Paystack webhook signature.",
      },
      session,
    ),
  );
