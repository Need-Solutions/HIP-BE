import type { OrderDocument } from "../../../database/models/orders.schema";
import { paystackDomain } from "../../../services/paystack.service";
import type { PaymentVerification } from "../../../services/paystack.service";

// Fail closed: a successful charge without the expected destination is a reconciliation case.
export function verifiedSplit(
  order: OrderDocument,
  value: PaymentVerification,
) {
  const fee = value.fees;
  const shares = value.split?.shares;
  const allocations = shares?.subaccounts;
  const single = value.fees_split;
  const hasSingle =
    single &&
    value.subaccount?.subaccount_code === order.subaccountCode &&
    single.params?.bearer === order.settlementBearer &&
    Number(single.params?.transaction_charge) === order.transactionChargeKobo;
  const hasMulti =
    allocations?.length === 1 &&
    allocations[0].subaccount_code === order.subaccountCode;
  if (
    order.settlementMode === "test_unsplit" ||
    !order.feeBreakdown ||
    !order.subaccountCode ||
    order.transactionChargeKobo === undefined ||
    value.domain !== order.settlementDomain ||
    !Number.isSafeInteger(fee) ||
    fee! < 0 ||
    (!hasSingle && !hasMulti)
  )
    return null;
  if (
    value.subaccount?.subaccount_code &&
    value.subaccount.subaccount_code !== order.subaccountCode
  )
    return null;
  const groupNet =
    order.amountKobo -
    order.transactionChargeKobo -
    (order.settlementBearer === "subaccount" ? fee! : 0);
  const platformNet = order.amountKobo - groupNet - fee!;
  if (groupNet < 0 || platformNet < 0) return null;
  if (
    hasSingle &&
    (single.subaccount !== groupNet ||
      single.paystack !== fee ||
      single.integration !== platformNet)
  )
    return null;
  if (
    hasMulti &&
    (allocations![0].amount !== groupNet ||
      shares?.paystack !== fee ||
      shares?.integration !== platformNet)
  )
    return null;
  return {
    actualPaystackFeeKobo: fee!,
    actualGroupNetKobo: groupNet,
    actualPlatformNetKobo: platformNet,
    splitVerifiedAt: new Date(),
  };
}

// A real test charge proves payment, never a bank settlement or split allocation.
export function verifiedTestPayment(
  order: OrderDocument,
  value: PaymentVerification,
) {
  if (
    paystackDomain() !== "test" ||
    order.settlementMode !== "test_unsplit" ||
    order.settlementDomain !== "test" ||
    value.domain !== "test" ||
    order.subaccountCode ||
    value.subaccount?.subaccount_code ||
    value.fees_split ||
    value.split?.shares?.subaccounts?.length ||
    !Number.isSafeInteger(value.fees) ||
    value.fees! < 0 ||
    value.fees! > order.amountKobo
  )
    return null;
  return {
    actualPaystackFeeKobo: value.fees!,
    actualGroupNetKobo: 0,
    actualPlatformNetKobo: 0,
  };
}
