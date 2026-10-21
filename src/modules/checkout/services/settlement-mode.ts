import type { ICheckoutSettings } from "../../../database/models/checkout-settings.schema";
import { paystackDomain } from "../../../services/paystack.service";
import { AppError } from "../../../shared/errors/app.error";

// Chosen only by the server, never by checkout request parameters.
export function settlementMode(
  policy: ICheckoutSettings,
): "split" | "test_unsplit" {
  const domain = paystackDomain();
  if (
    domain === "test" &&
    policy.providerDomain === "test" &&
    policy.localTestOnly
  )
    return "test_unsplit";
  if (
    !policy.localTestOnly &&
    policy.subaccountCode &&
    policy.providerDomain === domain &&
    (domain !== "live" || policy.accountVerified)
  )
    return "split";
  throw new AppError(
    503,
    "settlement_not_configured",
    "Paid checkout is unavailable until the group settlement account is configured.",
  );
}
