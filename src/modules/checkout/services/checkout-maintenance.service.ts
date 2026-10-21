import { CheckoutSettingsModel } from "../../../database/models/checkout-settings.schema";
import { SeatHoldModel } from "../../../database/models/seat-hold.schema";
import { OrderModel } from "../../../database/models/orders.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { GuestTicketLinkModel } from "../../../database/models/guest-ticket-link.schema";
import { EventSigningKeyModel } from "../../../database/models/event-signing-key.schema";
import { expireHolds } from "./seat-hold.service";
import { retryTicketMail } from "./checkout-mail.service";
import logger from "../../../utils/logging";

export async function initializeCheckout() {
  await Promise.all([
    CheckoutSettingsModel.init(),
    SeatHoldModel.init(),
    OrderModel.init(),
    TicketModel.init(),
    GuestTicketLinkModel.init(),
    EventSigningKeyModel.init(),
  ]);
}
export function startCheckoutMaintenance() {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await expireHolds();
      await retryTicketMail();
    } catch {
      logger.errors.error("Checkout maintenance could not complete.");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void run();
  }, 30000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
