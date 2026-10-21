import { createHmac, timingSafeEqual } from "crypto";
import { ENV } from "../../../config/env";
import { AppError } from "../../../shared/errors/app.error";
import { webhookPayment } from "./checkout.service";
import { invalidWebhookAudit } from "./payment-audit.service";

export async function handlePaystackWebhook(
  body: Buffer,
  signature: string | undefined,
) {
  if (!ENV.PAYSTACK_SECRET_KEY)
    throw new AppError(
      503,
      "payment_unavailable",
      "Paid checkout is not configured yet.",
    );
  const expected = createHmac("sha512", ENV.PAYSTACK_SECRET_KEY)
    .update(body)
    .digest();
  if (
    !signature ||
    !/^[a-f\d]{128}$/i.test(signature) ||
    !timingSafeEqual(expected, Buffer.from(signature, "hex"))
  ) {
    await invalidWebhookAudit();
    throw new AppError(401, "invalid_signature", "Invalid webhook signature.");
  }
  let event: { event?: string; data?: { reference?: unknown } };
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch {
    throw new AppError(400, "validation_error", "Invalid JSON request body.");
  }
  if (
    event &&
    event.event === "charge.success" &&
    typeof event.data?.reference === "string" &&
    /^[A-Za-z0-9.=-]{1,100}$/.test(event.data.reference)
  )
    await webhookPayment(event.data.reference);
}
