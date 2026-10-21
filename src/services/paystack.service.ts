import { ENV } from "../config/env";
import { AppError } from "../shared/errors/app.error";
import logger from "../utils/logging";

type SettlementAccount = {
  bank_code: string;
  account_number: string;
  account_name: string;
};

function subaccountFailure(
  code: unknown,
  message: unknown,
  account: SettlementAccount,
) {
  const redact = (value: unknown, fallback: string, nameParts = false) => {
    if (typeof value !== "string") return fallback;
    let text = value;
    for (const privateValue of [
      account.bank_code,
      account.account_number,
      account.account_name,
      ...(nameParts
        ? account.account_name.split(/\s+/).filter((part) => part.length > 1)
        : []),
      ENV.PAYSTACK_SECRET_KEY,
      ENV.JWT_SECRET,
      ENV.ENCRYPTION_KEY,
    ]) {
      if (!privateValue) continue;
      const escaped = privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(escaped, "gi"), "[redacted]");
    }
    return Array.from(
      text
        .replace(/\b(?:sk|pk)_(?:test|live)_[a-z\d]+\b/gi, "[redacted]")
        .replace(/\b(?:\d[\s-]?){6,}\b/g, "[redacted]")
        .replace(/https?:\/\/\S+/gi, "[redacted URL]"),
      (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
    )
      .join("")
      .slice(0, 400);
  };
  // Log only the two explicitly selected, redacted provider fields, never its body/request.
  logger.errors.error(
    `Paystack subaccount creation failed: ${JSON.stringify({
      code: redact(code, "unknown_error"),
      message: redact(
        message,
        "Paystack could not create the subaccount.",
        true,
      ),
    })}`,
  );
  return new AppError(
    502,
    "subaccount_creation_failed",
    "Paystack couldn’t create the settlement subaccount. Check the bank details and Paystack settings, then try again.",
  );
}

export interface PaymentVerification {
  reference: string;
  amount: number;
  currency: string;
  status: string;
  id: string | number;
  paid_at?: string | null;
  domain?: "test" | "live";
  fees?: number | null;
  subaccount?: { subaccount_code?: string };
  fees_split?: {
    paystack?: number;
    integration?: number;
    subaccount?: number;
    params?: { bearer?: string; transaction_charge?: string | number };
  } | null;
  split?: {
    shares?: {
      paystack?: number;
      integration?: number;
      subaccounts?: { amount: number; subaccount_code: string }[];
    };
  };
}
const unavailable = () =>
  new AppError(
    503,
    "payment_unavailable",
    "We couldn’t contact Paystack. Please try again shortly.",
  );
export function requirePaystack() {
  if (!ENV.PAYSTACK_SECRET_KEY)
    throw new AppError(
      503,
      "payment_unavailable",
      "Paid checkout is not configured yet.",
    );
  return ENV.PAYSTACK_SECRET_KEY;
}
async function call(
  path: string,
  body?: object,
  settlementAccount?: SettlementAccount,
) {
  const key = requirePaystack();
  try {
    const response = await fetch(`https://api.paystack.co${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    // Provider bodies can contain customer/payment data; never log them or forward provider messages.
    const value = (await response.json()) as {
      status?: boolean;
      data?: unknown;
      code?: unknown;
      type?: unknown;
      message?: unknown;
    };
    if (settlementAccount && (!response.ok || !value.status || !value.data))
      throw subaccountFailure(
        value.code ?? value.type ?? `http_${response.status}`,
        value.message,
        settlementAccount,
      );
    if (
      path.startsWith("/bank/resolve?") &&
      [400, 422].includes(response.status)
    )
      throw new AppError(
        422,
        "account_resolution_failed",
        "The bank account could not be resolved. Check the bank code and account number.",
        { field: "accountNumber" },
      );
    if (!response.ok || !value.status || !value.data) throw unavailable();
    return value.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (settlementAccount)
      throw subaccountFailure(
        "transport_error",
        "Could not contact Paystack to create the subaccount.",
        settlementAccount,
      );
    throw unavailable();
  }
}
export async function initializePayment(
  input: {
    reference: string;
    amountKobo: number;
    email: string;
    channel: string;
    callbackUrl: string;
  } & (
    | { settlementMode: "test_unsplit" }
    | {
        settlementMode?: "split";
        subaccountCode: string;
        transactionChargeKobo: number;
        bearer: "account" | "subaccount";
      }
  ),
) {
  if (input.settlementMode === "test_unsplit" && paystackDomain() !== "test")
    throw new AppError(
      409,
      "settlement_setup_required",
      "Test payments cannot use live credentials. Start a new checkout.",
    );
  const result = (await call("/transaction/initialize", {
    reference: input.reference,
    amount: String(input.amountKobo),
    currency: "NGN",
    email: input.email,
    channels: [input.channel],
    callback_url: input.callbackUrl,
    ...(input.settlementMode === "test_unsplit"
      ? {}
      : {
          subaccount: input.subaccountCode,
          transaction_charge: input.transactionChargeKobo,
          bearer: input.bearer,
        }),
  })) as {
    access_code?: string;
    reference?: string;
    authorization_url?: string;
  };
  if (
    result.reference !== input.reference ||
    !result.access_code ||
    !/^[A-Za-z0-9_-]+$/.test(result.access_code)
  )
    throw unavailable();
  return result.access_code;
}

export function paystackDomain(): "test" | "live" {
  return requirePaystack().startsWith("sk_test_") ? "test" : "live";
}
export async function resolveSettlementAccount(
  bankCode: string,
  accountNumber: string,
) {
  const query = new URLSearchParams({
    bank_code: bankCode,
    account_number: accountNumber,
  });
  const result = (await call(`/bank/resolve?${query}`)) as {
    account_name?: string;
    account_number?: string;
  };
  if (!result.account_name || result.account_number !== accountNumber)
    throw unavailable();
  return {
    accountName: result.account_name,
    accountNumber: result.account_number,
  };
}
export async function createSettlementSubaccount(
  bankCode: string,
  accountNumber: string,
  accountName: string,
) {
  const account = {
    bank_code: bankCode,
    account_number: accountNumber,
    account_name: accountName,
  };
  const result = (await call(
    "/subaccount",
    {
      business_name: accountName,
      ...account,
      percentage_charge: 0,
    },
    account,
  )) as {
    subaccount_code?: string;
    account_name?: string;
    account_number?: string;
    domain?: string;
    active?: boolean;
  };
  if (
    typeof result.subaccount_code !== "string" ||
    !/^ACCT_[A-Za-z0-9]+$/.test(result.subaccount_code) ||
    result.account_number !== accountNumber ||
    result.domain !== paystackDomain() ||
    result.active === false
  )
    throw subaccountFailure(
      "invalid_response",
      "Paystack returned an invalid subaccount creation response.",
      account,
    );
  return {
    code: result.subaccount_code,
    domain: result.domain as "test" | "live",
    accountName: result.account_name,
  };
}
export async function verifyPayment(
  reference: string,
): Promise<PaymentVerification> {
  const result = (await call(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  )) as PaymentVerification;
  if (
    typeof result.reference !== "string" ||
    !Number.isSafeInteger(result.amount) ||
    typeof result.currency !== "string" ||
    typeof result.status !== "string" ||
    !["string", "number"].includes(typeof result.id)
  )
    throw unavailable();
  return result;
}
