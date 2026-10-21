import { randomBytes } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import logger from "../utils/logging";
import { ENV, envSchema } from "../config/env";
import {
  initializePayment,
  verifyPayment,
  resolveSettlementAccount,
  createSettlementSubaccount,
} from "../services/paystack.service";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("Paystack transport", () => {
  it("initializes NGN server amounts with a stable reference and returns only the popup access code", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: true,
          data: { access_code: "test-access", reference: "HIP-reference" },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await initializePayment({
        reference: "HIP-reference",
        amountKobo: 203000,
        email: "buyer@example.com",
        channel: "card",
        callbackUrl: "http://localhost:5173/checkout/event",
        subaccountCode: "ACCT_fixture",
        transactionChargeKobo: 13000,
        bearer: "account",
      }),
    ).toBe("test-access");
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.paystack.co/transaction/initialize",
    );
    // Inspect only non-secret data; authorization headers are deliberately not snapshotted/assertion output.
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      amount: "203000",
      currency: "NGN",
      reference: "HIP-reference",
      channels: ["card"],
      subaccount: "ACCT_fixture",
      transaction_charge: 13000,
      bearer: "account",
    });
  });
  it("verifies the stored reference on Paystack and sanitizes upstream failures", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: true,
            data: {
              status: "success",
              reference: "HIP-reference",
              amount: 203000,
              currency: "NGN",
              id: "123456",
              paid_at: new Date().toISOString(),
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: false,
            message: "Private provider diagnostic",
          }),
          { status: 401 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    expect((await verifyPayment("HIP-reference")).currency).toBe("NGN");
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.paystack.co/transaction/verify/HIP-reference",
    );
    await expect(verifyPayment("HIP-reference")).rejects.toMatchObject({
      statusCode: 503,
      code: "payment_unavailable",
      message: "We couldn’t contact Paystack. Please try again shortly.",
    });
  });
  it("rejects malformed successful responses and validates an optional secret without reading the developer key", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ status: true, data: { amount: "203000" } }),
          ),
        ),
    );
    await expect(verifyPayment("HIP-reference")).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(
      envSchema.safeParse({ ...ENV, PAYSTACK_SECRET_KEY: "" }).success,
    ).toBe(true);
    expect(
      envSchema.safeParse({
        ...ENV,
        PAYSTACK_SECRET_KEY: `sk_test_${randomBytes(12).toString("hex")}`,
      }).success,
    ).toBe(true);
    expect(
      envSchema.safeParse({ ...ENV, PAYSTACK_SECRET_KEY: "invalid" }).success,
    ).toBe(false);
  });
});

it("resolves bank details and registers only a matching test subaccount", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: true,
          data: {
            account_name: "Bank test fixture",
            account_number: "0000000000",
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: true,
          data: {
            subaccount_code: "ACCT_fixture",
            account_name: "Bank test fixture",
            account_number: "0000000000",
            active: true,
            domain: "test",
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: false, message: "Private bank diagnostic" }),
        { status: 422 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(
    (await resolveSettlementAccount("057", "0000000000")).accountName,
  ).toBe("Bank test fixture");
  expect(
    (await createSettlementSubaccount("057", "0000000000", "Bank test fixture"))
      .code,
  ).toBe("ACCT_fixture");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
    business_name: "Bank test fixture",
    account_name: "Bank test fixture",
    bank_code: "057",
    percentage_charge: 0,
  });
  await expect(
    resolveSettlementAccount("057", "0000000000"),
  ).rejects.toMatchObject({ code: "account_resolution_failed" });
});

it("logs only redacted Paystack creation diagnostics and returns a distinct safe error", async () => {
  const logged = vi
    .spyOn(logger.errors, "error")
    .mockImplementation(() => logger.errors);
  const accountName = "Synthetic Bank Holder";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: false,
          code: "invalid_bank",
          message: `Cannot create subaccount: ${accountName}, bank 057, account 0000000000. Authorization ${ENV.PAYSTACK_SECRET_KEY}`,
          data: { account_name: accountName, account_number: "0000000000" },
        }),
        { status: 400 },
      ),
    ),
  );
  let failure: unknown;
  try {
    await createSettlementSubaccount("057", "0000000000", accountName);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    statusCode: 502,
    code: "subaccount_creation_failed",
    message:
      "Paystack couldn’t create the settlement subaccount. Check the bank details and Paystack settings, then try again.",
  });
  const output = String(logged.mock.calls[0][0]);
  expect(output).toContain('"code":"invalid_bank"');
  expect(output).toContain("Cannot create subaccount");
  // Assert booleans, so even a failing assertion cannot print private values.
  expect(
    [accountName, "057", "0000000000", ENV.PAYSTACK_SECRET_KEY!].every(
      (value) => !output.includes(value),
    ),
  ).toBe(true);
  expect(output.includes('"data"')).toBe(false);
});
it("reports creation transport failures without logging raw errors", async () => {
  const logged = vi
    .spyOn(logger.errors, "error")
    .mockImplementation(() => logger.errors);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Sensitive transport diagnostic")),
  );
  await expect(
    createSettlementSubaccount("057", "0000000000", "Bank fixture"),
  ).rejects.toMatchObject({
    code: "subaccount_creation_failed",
    statusCode: 502,
  });
  expect(String(logged.mock.calls[0][0])).toContain('"code":"transport_error"');
  expect(
    String(logged.mock.calls[0][0]).includes("Sensitive transport diagnostic"),
  ).toBe(false);
});

it("omits split parameters for test payments, but refuses that path with a live key", async () => {
  const original = ENV.PAYSTACK_SECRET_KEY;
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          status: true,
          data: { access_code: "test-access", reference: "HIP-test-unsplit" },
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const input = {
    reference: "HIP-test-unsplit",
    amountKobo: 276650,
    email: "buyer@example.test",
    channel: "card",
    callbackUrl: "http://localhost:5173/checkout/event",
    settlementMode: "test_unsplit" as const,
  };
  try {
    ENV.PAYSTACK_SECRET_KEY = `sk_test_${randomBytes(12).toString("hex")}`;
    expect(await initializePayment(input)).toBe("test-access");
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("subaccount");
    expect(body).not.toHaveProperty("transaction_charge");
    expect(body).not.toHaveProperty("bearer");
    expect(body).toMatchObject({ amount: "276650", currency: "NGN" });
    ENV.PAYSTACK_SECRET_KEY = `sk_live_${randomBytes(12).toString("hex")}`;
    await expect(initializePayment(input)).rejects.toMatchObject({
      code: "settlement_setup_required",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    ENV.PAYSTACK_SECRET_KEY = original;
  }
});
