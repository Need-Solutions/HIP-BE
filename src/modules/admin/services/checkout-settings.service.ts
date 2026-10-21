import { createHmac } from "crypto";
import type { ClientSession } from "mongoose";
import { ENV } from "../../../config/env";
import {
  CheckoutSettingsModel,
  type FeePolicy,
  type ICheckoutSettings,
} from "../../../database/models/checkout-settings.schema";
import type { AdminDocument } from "../../../database/models/admin.schema";
import { AppError } from "../../../shared/errors/app.error";
import { transaction } from "../../../shared/database/transaction";
import {
  createSettlementSubaccount,
  paystackDomain,
  resolveSettlementAccount,
} from "../../../services/paystack.service";
import { recordAudit } from "./audit-log.service";

export async function settings(session?: ClientSession) {
  return CheckoutSettingsModel.findOneAndUpdate(
    { _id: "checkout" },
    {
      $setOnInsert: {
        platformFeePercent: ENV.PLATFORM_FEE_PERCENT,
        platformFeeMode: ENV.PLATFORM_FEE_MODE,
        platformFeeOnRefund: ENV.PLATFORM_FEE_ON_REFUND,
        paystackFeeBearer: ENV.PAYSTACK_FEE_BEARER,
      },
    },
    { upsert: true, new: true, session },
  );
}
function response(value: ICheckoutSettings) {
  return {
    platformFeePercent: value.platformFeePercent ?? null,
    platformFeeMode: value.platformFeeMode,
    platformFeeOnRefund: value.platformFeeOnRefund,
    paystackFeeBearer: value.paystackFeeBearer,
    paymentMode: ENV.PAYSTACK_SECRET_KEY ? paystackDomain() : null,
    paidCheckoutReady: Boolean(
      ENV.PAYSTACK_SECRET_KEY &&
        value.platformFeePercent &&
        value.providerDomain === paystackDomain() &&
        (value.localTestOnly
          ? paystackDomain() === "test"
          : value.subaccountCode &&
            (paystackDomain() !== "live" || value.accountVerified)),
    ),
    settlement:
      value.subaccountCode || value.localTestOnly
        ? {
            subaccountCode: value.subaccountCode ?? null,
            localTestOnly: value.localTestOnly ?? false,
            domain: value.providerDomain,
            bankCode: value.bankCode,
            accountName: value.accountName,
            accountLast4: value.accountLast4,
            accountVerified: value.accountVerified ?? false,
          }
        : null,
  };
}
export async function get() {
  return response(await settings());
}
export async function update(input: FeePolicy, actor: AdminDocument) {
  return transaction(async (session) => {
    const value = await settings(session);
    Object.assign(value, input);
    await value.save({ session });
    await recordAudit(
      actor,
      {
        action: "checkout.settings_updated",
        target: { type: "checkout_settings", id: "checkout" },
        details: `Platform fee ${value.platformFeePercent}%; ${value.platformFeeMode}; refund policy ${value.platformFeeOnRefund}; Paystack paid by ${value.paystackFeeBearer}.`,
      },
      session,
    );
    return response(value);
  });
}
export async function registerAccount(
  input: {
    bankCode: string;
    accountNumber: string;
    accountName: string;
    registerWithPaystack?: boolean;
  },
  actor: AdminDocument,
) {
  const domain = paystackDomain();
  const localTestOnly =
    domain === "test" && input.registerWithPaystack !== true;
  const fingerprint = createHmac("sha256", ENV.ENCRYPTION_KEY!)
    .update(`${input.bankCode}:${input.accountNumber}`)
    .digest("hex");
  await settings();
  const existing = await CheckoutSettingsModel.findById("checkout").select(
    "+accountFingerprint",
  );
  if (existing?.subaccountCode) {
    if (
      existing.accountFingerprint === fingerprint &&
      existing.providerDomain === paystackDomain()
    )
      return response(existing);
    throw new AppError(
      409,
      "settlement_already_configured",
      "A settlement account is already configured. Contact support to change it.",
    );
  }
  if (
    localTestOnly &&
    existing?.localTestOnly &&
    existing.accountFingerprint === fingerprint
  )
    return response(existing);
  const lease = new Date(Date.now() + 60000);
  const claimed = await CheckoutSettingsModel.findOneAndUpdate(
    {
      _id: "checkout",
      subaccountCode: { $exists: false },
      $or: [
        { setupLeaseUntil: { $exists: false } },
        { setupLeaseUntil: { $lte: new Date() } },
      ],
    },
    { $set: { setupLeaseUntil: lease } },
  );
  if (!claimed)
    throw new AppError(
      409,
      "settlement_setup_in_progress",
      "Settlement setup is in progress. Please try again shortly.",
    );
  try {
    // Dummy test accounts must never reach account resolution. Live accounts must.
    const accountVerified = domain === "live";
    const resolved = accountVerified
      ? await resolveSettlementAccount(input.bankCode, input.accountNumber)
      : { accountName: input.accountName, accountNumber: input.accountNumber };
    const normalize = (value: string) =>
      value
        .normalize("NFKD")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
    if (
      accountVerified &&
      normalize(resolved.accountName) !== normalize(input.accountName)
    )
      throw new AppError(
        422,
        "account_name_mismatch",
        "The account name does not match the bank's records. Check the name and try again.",
        { field: "accountName" },
      );
    const subaccount = localTestOnly
      ? undefined
      : await createSettlementSubaccount(
          input.bankCode,
          input.accountNumber,
          input.accountName,
        );
    return await transaction(async (session) => {
      const value = await CheckoutSettingsModel.findOneAndUpdate(
        {
          _id: "checkout",
          setupLeaseUntil: lease,
          subaccountCode: { $exists: false },
        },
        {
          $set: {
            ...(subaccount ? { subaccountCode: subaccount.code } : {}),
            providerDomain: domain,
            localTestOnly,
            bankCode: input.bankCode,
            accountName: resolved.accountName,
            accountVerified,
            accountLast4: input.accountNumber.slice(-4),
            accountFingerprint: fingerprint,
          },
          $unset: {
            setupLeaseUntil: 1,
            ...(localTestOnly ? { subaccountCode: 1 } : {}),
          },
        },
        { new: true, session },
      );
      if (!value)
        throw new AppError(
          409,
          "settlement_setup_in_progress",
          "Settlement setup changed. Please check the saved account.",
        );
      await recordAudit(
        actor,
        {
          action: localTestOnly
            ? "checkout.test_settlement_saved"
            : "checkout.settlement_configured",
          target: { type: "checkout_settings", id: "checkout" },
          details: localTestOnly
            ? "Saved local test bank settings. No Paystack subaccount was created."
            : `Configured ${domain} settlement subaccount; account resolution ${accountVerified ? "verified" : "test-mode bypass"}.`,
        },
        session,
      );
      return response(value);
    });
  } finally {
    await CheckoutSettingsModel.updateOne(
      { _id: "checkout", setupLeaseUntil: lease },
      { $unset: { setupLeaseUntil: 1 } },
    );
  }
}
