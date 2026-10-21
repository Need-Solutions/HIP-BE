import { OrderModel } from "../../../database/models/orders.schema";
import { sendMail } from "../../../services/mail.service";
import { decrypt } from "../../../shared/security/encryption";
import { GuestTicketLinkModel } from "../../../database/models/guest-ticket-link.schema";
import { hashToken } from "./checkout-access.service";
import { GUEST_LINK_MS } from "../../tickets/services/guest-link.service";

export interface TicketMail {
  to: string;
  subject: string;
  text: string;
}
export async function deliverOrderMail(orderId: string) {
  const now = new Date();
  const order = await OrderModel.findOneAndUpdate(
    {
      _id: orderId,
      status: "paid",
      deliveryState: "pending",
      $or: [
        { deliveryLeaseUntil: { $exists: false } },
        { deliveryLeaseUntil: { $lte: now } },
      ],
    },
    { $set: { deliveryLeaseUntil: new Date(now.getTime() + 120000) } },
    { new: true },
  ).select("+deliveryPayload");
  if (!order?.deliveryPayload) return;
  const lease = order.deliveryLeaseUntil;
  try {
    const messages = JSON.parse(
      decrypt(order.deliveryPayload, `hip:ticket-mail:${order.id}`),
    ) as TicketMail[];
    for (const message of messages) {
      // SMTP may have been unavailable for longer than a link's lifetime. Start its
      // redemption window at delivery; a link already redeemed still stays single use.
      for (const match of message.text.matchAll(/[?&]token=([a-f0-9]{64})/g)) {
        await GuestTicketLinkModel.updateOne(
          { tokenHash: hashToken(match[1]), usedAt: { $exists: false } },
          { $set: { expiresAt: new Date(Date.now() + GUEST_LINK_MS) } },
        );
      }
      await sendMail(message);
    }
    await OrderModel.updateOne(
      { _id: order._id, deliveryLeaseUntil: lease },
      {
        $set: { deliveryState: "sent" },
        $unset: { deliveryPayload: 1, deliveryLeaseUntil: 1 },
      },
    );
  } catch {
    // Keep the encrypted outbox for retry. A mail failure never reverses a confirmed purchase.
    await OrderModel.updateOne(
      { _id: order._id, deliveryLeaseUntil: lease },
      { $set: { deliveryLeaseUntil: new Date(Date.now() + 60000) } },
    );
  }
}
export async function retryTicketMail() {
  const orders = await OrderModel.find({
    status: "paid",
    deliveryState: "pending",
    $or: [
      { deliveryLeaseUntil: { $exists: false } },
      { deliveryLeaseUntil: { $lte: new Date() } },
    ],
  })
    .select("_id")
    .limit(20);
  for (const order of orders) await deliverOrderMail(order.id);
}
