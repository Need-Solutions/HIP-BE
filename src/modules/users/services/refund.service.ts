import { mongo } from "mongoose";
import { UserModel } from "../../../database/models/users.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { CheckInModel } from "../../../database/models/check-in.schema";
import { RefundRequestModel } from "../../../database/models/refund-request.schema";
import { AppError } from "../../../shared/errors/app.error";
import { transaction } from "../../../shared/database/transaction";
import { appendAudit } from "../../admin/services/audit-log.service";
import { ticketRefundAmounts } from "../../checkout/services/fees";
import { checkInOpens } from "./account-event-time";
import {
  ownedTicket,
  reconcileAccount,
  refundResponse,
} from "./account-tickets.service";
import { queueAccountJob, deliverAccountJob } from "./account-jobs.service";

function refundPolicy(
  item: Awaited<ReturnType<typeof ownedTicket>>,
  existing: boolean,
  checkedIn: boolean,
  now = Date.now(),
) {
  let reason: string | null = null;
  if (!item.boughtByMe)
    reason = "Only the person who paid can request this refund.";
  else if (existing)
    reason = "A refund request already exists for this ticket.";
  else if (checkedIn || item.ticket.status === "checked_in")
    reason = "Checked-in tickets cannot be refunded.";
  else if (item.ticket.pricePaidKobo <= 0)
    reason = "Free tickets cannot be refunded.";
  else if (item.ticket.status !== "confirmed" || item.order.status !== "paid")
    reason = "This ticket cannot be refunded.";
  else if (
    item.event.status === "cancelled" ||
    item.event.status === "completed" ||
    now >= checkInOpens(item.event)
  )
    reason =
      "Refunds are not allowed once check-in opens or the event has ended or been cancelled.";
  const percent = reason
    ? 0
    : item.event.startsAt!.getTime() - now >= 72 * 3600000
      ? 100
      : 50;
  const breakdown = percent
    ? ticketRefundAmounts(
        item.ticket.pricePaidKobo,
        percent,
        item.order.feeBreakdown,
      )
    : null;
  return {
    eligible: !reason,
    percent,
    amount: breakdown?.totalRefundKobo ?? 0,
    platformFeeRefunded: breakdown?.platformFeeRefundedKobo ?? 0,
    reason,
    breakdown,
  };
}
export async function refundQuote(userId: string, code: string) {
  await reconcileAccount(userId);
  const item = await ownedTicket(userId, code);
  const quote = refundPolicy(
    item,
    !!(await RefundRequestModel.exists({ ticket: item.ticket._id })),
    !!(await CheckInModel.exists({ ticket: item.ticket._id })),
  );
  return {
    eligible: quote.eligible,
    percent: quote.percent,
    amount: quote.amount,
    platformFeeRefunded: quote.platformFeeRefunded,
    reason: quote.reason,
  };
}
export async function requestRefund(
  userId: string,
  code: string,
  body: { reason: string; note?: string },
) {
  await reconcileAccount(userId);
  try {
    const result = await transaction(async (session) => {
      const user = await UserModel.findOneAndUpdate(
        { _id: userId, status: "active" },
        { $inc: { ticketChanges: 1 } },
        { new: true, session },
      );
      if (!user)
        throw new AppError(
          401,
          "unauthenticated",
          "Please log in to continue.",
        );
      const item = await ownedTicket(userId, code, session);
      const quote = refundPolicy(
        item,
        !!(await RefundRequestModel.exists({ ticket: item.ticket._id }).session(
          session,
        )),
        !!(await CheckInModel.exists({ ticket: item.ticket._id }).session(
          session,
        )),
      );
      if (!quote.eligible || !quote.breakdown)
        throw new AppError(
          409,
          "REFUND_NOT_ALLOWED",
          quote.reason ?? "This ticket cannot be refunded.",
        );
      const claimed = await TicketModel.updateOne(
        { _id: item.ticket._id, status: "confirmed" },
        { $set: { status: "refund_pending" } },
        { session },
      );
      if (!claimed.modifiedCount)
        throw new AppError(
          409,
          "REFUND_NOT_ALLOWED",
          "This ticket cannot be refunded.",
        );
      const [refund] = await RefundRequestModel.create(
        [
          {
            ticket: item.ticket._id,
            user: user._id,
            order: item.order._id,
            amountKobo: quote.amount,
            percent: quote.percent,
            feeBreakdown: quote.breakdown,
            reason: body.reason,
            ...(body.note ? { note: body.note } : {}),
          },
        ],
        { session },
      );
      await appendAudit(
        { id: user.id, name: user.fullName, role: "hiker" },
        {
          action: "refund.requested",
          target: { type: "ticket", id: item.ticket.id },
          details: `Requested a ${quote.percent}% refund of ${quote.amount} kobo for ${item.ticket.code}.`,
          reason: body.reason,
        },
        session,
      );
      const jobId = await queueAccountJob(
        "mail",
        {
          to: user.email,
          subject: "Refund request received",
          text: `We received your refund request for ${item.ticket.code}. The requested amount is ${quote.amount} kobo (${quote.percent}%). It is pending review. No refund has been paid yet.`,
        },
        session,
      );
      return { response: refundResponse(refund), jobId };
    });
    await deliverAccountJob(result.jobId);
    return result.response;
  } catch (error) {
    if (error instanceof mongo.MongoServerError && error.code === 11000)
      throw new AppError(
        409,
        "REFUND_NOT_ALLOWED",
        "A refund request already exists for this ticket.",
      );
    throw error;
  }
}
