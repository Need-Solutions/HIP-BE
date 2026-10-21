import { randomBytes } from "crypto";
import { type ClientSession, Types } from "mongoose";
import { ENV } from "../../../config/env";
import { GuestTicketLinkModel } from "../../../database/models/guest-ticket-link.schema";
import { hashToken } from "../../checkout/services/checkout-access.service";

export const GUEST_LINK_MS = 30 * 60000;
export const GUEST_ACCESS_MS = 24 * 3600000;
export async function createGuestLink(
  ticketId: Types.ObjectId,
  code: string,
  session?: ClientSession,
) {
  const token = randomBytes(32).toString("hex");
  await GuestTicketLinkModel.create(
    [
      {
        ticketId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + GUEST_LINK_MS),
      },
    ],
    session ? { session } : {},
  );
  const url = new URL(`/tickets/${code}`, ENV.CLIENT_URL);
  url.searchParams.set("token", token);
  return url.toString();
}
export async function guestCanView(
  ticketId: Types.ObjectId,
  browserHash?: string,
  token?: string,
) {
  if (!browserHash) return false;
  const now = new Date();
  if (token) {
    const consumed = await GuestTicketLinkModel.findOneAndUpdate(
      {
        ticketId,
        tokenHash: hashToken(token),
        usedAt: { $exists: false },
        expiresAt: { $gt: now },
      },
      {
        $set: {
          usedAt: now,
          browserHash,
          accessExpiresAt: new Date(now.getTime() + GUEST_ACCESS_MS),
        },
      },
    );
    if (consumed) return true;
  }
  // A one-time link grants this browser access, so refreshes do not consume the link again.
  return Boolean(
    await GuestTicketLinkModel.exists({
      ticketId,
      browserHash,
      accessExpiresAt: { $gt: now },
    }),
  );
}
