import { AppError } from "../../../shared/errors/app.error";
import type { FeePolicy } from "../../../database/models/checkout-settings.schema";

export interface FeeBreakdown extends FeePolicy {
  platformFeePercent: number;
  subtotalKobo: number;
  paystackFeeKobo: number;
  platformFeeKobo: number;
  buyerPaystackFeeKobo: number;
  buyerPlatformFeeKobo: number;
  groupNetKobo: number;
  totalKobo: number;
}

export function settlementTotals(
  lines: { priceKobo: number; quantity: number }[],
  policy: FeePolicy,
): FeeBreakdown {
  const fail = () =>
    new AppError(
      422,
      "invalid_fee_configuration",
      "The configured fees cannot be applied to this order. Contact the group.",
    );
  let subtotal = BigInt(0),
    platform = BigInt(0);
  const percent = policy.platformFeePercent ?? 0;
  if (
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    !Number.isInteger(Number((percent * 100).toFixed(8)))
  )
    throw fail();
  const basisPoints = BigInt(Math.round(percent * 100));
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.priceKobo) ||
      line.priceKobo < 0 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1
    )
      throw fail();
    subtotal += BigInt(line.priceKobo) * BigInt(line.quantity);
    // Half-up rounding per ticket, then multiply by quantity. Free tickets always contribute zero.
    const perTicketFee =
      (BigInt(line.priceKobo) * basisPoints + BigInt(5000)) / BigInt(10000);
    if (line.priceKobo > 0 && percent > 0 && perTicketFee === BigInt(0))
      throw fail();
    platform += perTicketFee * BigInt(line.quantity);
  }
  if (
    subtotal > BigInt(Number.MAX_SAFE_INTEGER) ||
    platform > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw fail();
  if (subtotal > BigInt(0) && (!percent || platform === BigInt(0)))
    throw new AppError(
      503,
      "platform_fee_not_configured",
      "A positive platform fee must be configured before paid checkout.",
    );
  const subtotalKobo = Number(subtotal),
    platformFeeKobo = Number(platform);
  const buyerPlatformFeeKobo =
    policy.platformFeeMode === "added_to_buyer" ? platformFeeKobo : 0;
  const base = subtotalKobo + buyerPlatformFeeKobo;
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(base + 200000))
    throw fail();
  let buyerPaystackFeeKobo = 0;
  if (base && policy.paystackFeeBearer === "hiker") {
    // Paystack charges on the final collected amount, including buyer-paid fees.
    // Find the smallest integer surcharge that covers that fee, including the flat-fee threshold/cap.
    // The NGN 2,500 threshold has a discontinuity. Prefer a valid fee below it
    // before searching the higher branch, otherwise a binary search can overcharge.
    const belowThreshold = Math.min(200000, 249999 - base);
    let low = 0,
      high =
        belowThreshold >= 0 &&
        belowThreshold >= paystackFeeKobo(base + belowThreshold)
          ? belowThreshold
          : 200000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (mid >= paystackFeeKobo(base + mid)) high = mid;
      else low = mid + 1;
    }
    buyerPaystackFeeKobo = low;
  }
  const totalKobo = base + buyerPaystackFeeKobo;
  const paystackFee = paystackFeeKobo(totalKobo);
  const groupNetKobo = totalKobo - platformFeeKobo - paystackFee;
  if (groupNetKobo < 0) throw fail();
  return {
    platformFeeMode: policy.platformFeeMode,
    platformFeeOnRefund: policy.platformFeeOnRefund,
    paystackFeeBearer: policy.paystackFeeBearer,
    platformFeePercent: percent,
    subtotalKobo,
    paystackFeeKobo: paystackFee,
    platformFeeKobo,
    buyerPaystackFeeKobo,
    buyerPlatformFeeKobo,
    groupNetKobo,
    totalKobo,
  };
}

export function paystackFeeKobo(amountKobo: number) {
  if (amountKobo <= 0) return 0;
  if (amountKobo >= 12666667) return 200000;
  // Integer arithmetic matches frontend Math.round(subtotal * 0.015), without float money.
  return Math.min(
    Math.floor((amountKobo * 15 + 500) / 1000) +
      (amountKobo < 250000 ? 0 : 10000),
    200000,
  );
}
export function orderTotals(subtotalKobo: number) {
  const feeKobo = paystackFeeKobo(subtotalKobo);
  if (
    !Number.isSafeInteger(subtotalKobo) ||
    subtotalKobo < 0 ||
    !Number.isSafeInteger(subtotalKobo + feeKobo)
  )
    throw new AppError(
      422,
      "amount_too_large",
      "This order amount is too large. Contact the group.",
      { field: "items" },
    );
  return { subtotalKobo, feeKobo, amountKobo: subtotalKobo + feeKobo };
}
