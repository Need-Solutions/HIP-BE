import bcrypt from "bcrypt";
import { promisify } from "util";
import { UserModel } from "../../../database/models/users.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { OrderModel } from "../../../database/models/orders.schema";
import { EventModel } from "../../../database/models/events.schema";
import { CheckInModel } from "../../../database/models/check-in.schema";
import { RefundRequestModel } from "../../../database/models/refund-request.schema";
import { PasswordResetModel } from "../../../database/models/password-reset.schema";
import { ContactChangeModel } from "../../../database/models/contact-change.schema";
import { VerificationCodeModel } from "../../../database/models/verification-code.schema";
import { AppError } from "../../../shared/errors/app.error";
import { transaction } from "../../../shared/database/transaction";
import { appendAudit } from "../../admin/services/audit-log.service";
import { getProfile } from "./profile.service";
import { hikingHistory } from "./history.service";
import { eventEnded } from "./account-event-time";
import { queueAccountJob, deliverAccountJob } from "./account-jobs.service";
import { reconcileAccount } from "./account-tickets.service";

const comparePassword = promisify(bcrypt.compare);

export async function exportAccount(userId: string) {
  await reconcileAccount(userId);
  const profile = await getProfile(userId);
  const history = await hikingHistory(userId);
  const orders = await OrderModel.find({ buyerUserId: userId });
  const tickets = await TicketModel.find({
    $or: [
      { holderUserId: userId },
      { orderId: { $in: orders.map((o) => o._id) } },
    ],
  });
  const events = new Map(
    (
      await EventModel.find({ _id: { $in: tickets.map((t) => t.eventId) } })
    ).map((e) => [e.id, e]),
  );
  const refunds = await RefundRequestModel.find({ user: userId });
  const checks = await CheckInModel.find({ user: userId });
  // Explicit allowlists only: never serialize a Mongoose document into an export.
  return {
    exportedAt: new Date().toISOString(),
    about:
      "Your HIP account data. Attendance comes only from recorded check-ins. Payment amounts are in kobo.",
    profile: {
      user: {
        fullName: profile.user.fullName,
        email: profile.user.email,
        phone: profile.user.phone,
        roles: profile.user.roles,
        status: profile.user.status,
        emailVerified: profile.user.emailVerified,
        phoneVerified: profile.user.phoneVerified,
        createdAt: profile.user.createdAt,
      },
      ...(profile.dateOfBirth ? { dateOfBirth: profile.dateOfBirth } : {}),
      ...(profile.emergencyContact
        ? { emergencyContact: profile.emergencyContact }
        : {}),
      hasPhoto: !!profile.photoUrl,
      hikesAttended: profile.hikesAttended,
      notifications: profile.notifications,
    },
    tickets: tickets.map((t) => ({
      code: t.code,
      event: events.get(String(t.eventId))?.title ?? "Unavailable event",
      eventDate: events.get(String(t.eventId))?.startsAt?.toISOString(),
      ticketType: t.ticketTypeName,
      status: t.status,
      holder: t.holder.fullName,
      ...(String(t.holderUserId) === userId &&
      !orders.some((o) => o._id.equals(t.orderId))
        ? { boughtBy: "someone else" }
        : {}),
    })),
    hikingHistory: history.entries.map((e) => ({
      event: e.event.title,
      date: e.event.startsAt,
      outcome: e.outcome,
      ...(e.checkIn ? { checkedInAt: e.checkIn.at } : {}),
    })),
    payments: orders.map((o) => ({
      reference: o.reference,
      amountKobo: o.amountKobo,
      subtotalKobo: o.subtotalKobo,
      paystackFeeKobo: o.feeBreakdown?.paystackFeeKobo ?? o.feeKobo,
      platformFeeKobo: o.feeBreakdown?.platformFeeKobo ?? 0,
    })),
    refundRequests: refunds.map((r) => ({
      ticketCode: tickets.find((t) => t._id.equals(r.ticket))?.code,
      amountKobo: r.amountKobo,
      percent: r.percent,
      feeBreakdown: {
        ticketSubtotalKobo: r.feeBreakdown.ticketSubtotalKobo,
        ticketRefundKobo: r.feeBreakdown.ticketRefundKobo,
        platformFeeKobo: r.feeBreakdown.platformFeeKobo,
        platformFeeRefundedKobo: r.feeBreakdown.platformFeeRefundedKobo,
        paystackFeeRefundedKobo: r.feeBreakdown.paystackFeeRefundedKobo,
        totalRefundKobo: r.feeBreakdown.totalRefundKobo,
        platformFeeOnRefund: r.feeBreakdown.platformFeeOnRefund,
        platformFeeMode: r.feeBreakdown.platformFeeMode,
      },
      reason: r.reason,
      ...(r.note ? { note: r.note } : {}),
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    checkIns: checks.map((c) => ({
      ticketCode: tickets.find((t) => t._id.equals(c.ticket))?.code,
      event: events.get(String(c.event))?.title,
      checkedInAt: c.checkedInAt.toISOString(),
      method: c.method,
      synced: c.synced,
    })),
    notificationPreferences: profile.notifications,
  };
}
export async function deleteAccount(userId: string, password: string) {
  const original = await UserModel.findOne({
    _id: userId,
    status: "active",
  }).select("+passwordHash");
  if (!original || !(await comparePassword(password, original.passwordHash)))
    throw new AppError(400, "invalid_password", "That password is incorrect.", {
      field: "password",
    });
  await reconcileAccount(userId);
  const jobs = await transaction(async (session) => {
    // Conflicts with checkout linking, contact changes and password resets before commit.
    const user = await UserModel.findOneAndUpdate(
      { _id: userId, status: "active", passwordHash: original.passwordHash },
      { $inc: { ticketChanges: 1 } },
      { new: true, session },
    ).select("+photoPublicId");
    if (!user)
      throw new AppError(
        409,
        "account_changed",
        "Your account changed. Please sign in again before deleting it.",
      );
    const tickets = await TicketModel.find({
      holderUserId: userId,
      status: { $in: ["confirmed", "refund_pending", "checked_in"] },
    }).session(session);
    for (const ticket of tickets) {
      const event = await EventModel.findById(ticket.eventId).session(session);
      if (event && event.status !== "cancelled" && !eventEnded(event))
        throw new AppError(
          409,
          "ACCOUNT_HAS_UPCOMING_TICKETS",
          "You have upcoming tickets. Request refunds or wait until those events have passed before deleting your account.",
        );
    }
    const pendingJobs = [];
    if (user.email)
      pendingJobs.push(
        await queueAccountJob(
          "mail",
          {
            to: user.email,
            subject: "Your HIP account has been deleted",
            text: "Your HIP account has been anonymised and your sessions have ended. The group retains ticket, payment and check-in records for its records and analytics.",
          },
          session,
        ),
      );
    if (user.photoPublicId)
      pendingJobs.push(
        await queueAccountJob(
          "remove_photo",
          { publicId: user.photoPublicId },
          session,
        ),
      );
    await UserModel.updateOne(
      { _id: userId },
      {
        $set: {
          fullName: "Deleted hiker",
          status: "deleted",
          emailVerified: false,
          phoneVerified: false,
          notifications: {
            ticketConfirmations: true,
            reminders: false,
            reminderChannel: "email",
            promotions: false,
          },
        },
        $inc: { sessionVersion: 1 },
        $unset: {
          email: 1,
          phone: 1,
          passwordHash: 1,
          dateOfBirth: 1,
          emergencyContact: 1,
          photoUrl: 1,
          photoPublicId: 1,
        },
      },
      { session },
    );
    await PasswordResetModel.deleteMany({ userId }).session(session);
    await VerificationCodeModel.deleteMany({ userId }).session(session);
    await ContactChangeModel.deleteMany({ userId }).session(session);
    await appendAudit(
      { id: user.id, name: "Deleted hiker", role: "hiker" },
      {
        action: "hiker.deleted",
        target: { type: "hiker", id: userId },
        details:
          "Hiker account anonymised and all sessions revoked. Financial and attendance records retained.",
      },
      session,
    );
    return pendingJobs;
  });
  for (const job of jobs) await deliverAccountJob(job);
}
