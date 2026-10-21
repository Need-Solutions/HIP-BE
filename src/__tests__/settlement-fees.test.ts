import { describe, expect, it } from "vitest";
import {
  settlementTotals,
  paystackFeeKobo,
} from "../modules/checkout/services/fees";
import type { FeePolicy } from "../database/models/checkout-settings.schema";
const policy: FeePolicy = {
  platformFeePercent: 5,
  platformFeeMode: "added_to_buyer",
  platformFeeOnRefund: "refund",
  paystackFeeBearer: "hiker",
};
const totals = (
  priceKobo: number,
  override: Partial<FeePolicy> = {},
  quantity = 1,
) => settlementTotals([{ priceKobo, quantity }], { ...policy, ...override });
describe("Integer settlement fee calculations", () => {
  it.each([
    ["added_to_buyer", "hiker", 276650, 250000, 14150],
    ["added_to_buyer", "group", 262500, 236062, 13938],
    ["deducted_from_group", "hiker", 263959, 237500, 13959],
    ["deducted_from_group", "group", 250000, 223750, 13750],
  ] as const)(
    "%s / %s",
    (
      platformFeeMode,
      paystackFeeBearer,
      totalKobo,
      groupNetKobo,
      paystackFee,
    ) => {
      const result = totals(250000, { platformFeeMode, paystackFeeBearer });
      expect(result).toMatchObject({
        totalKobo,
        groupNetKobo,
        paystackFeeKobo: paystackFee,
        platformFeeKobo: 12500,
      });
      expect(result.totalKobo).toBe(
        result.groupNetKobo + result.platformFeeKobo + result.paystackFeeKobo,
      );
    },
  );
  it("rounds half up per ticket, uses basis points and never charges fees for free tickets", () => {
    expect(totals(10, {}, 3).platformFeeKobo).toBe(3);
    expect(totals(101, { platformFeePercent: 2.5 }, 3).platformFeeKobo).toBe(9);
    expect(totals(0, { platformFeePercent: undefined }, 10)).toMatchObject({
      subtotalKobo: 0,
      totalKobo: 0,
      platformFeeKobo: 0,
      paystackFeeKobo: 0,
      groupNetKobo: 0,
    });
    expect(
      settlementTotals(
        [
          { priceKobo: 0, quantity: 1 },
          { priceKobo: 200000, quantity: 1 },
        ],
        policy,
      ).platformFeeKobo,
    ).toBe(10000);
  });
  it("covers processing on the final amount, including threshold and cap", () => {
    for (const price of [
      1, 100, 199999, 230000, 233400, 240000, 249999, 250000, 250001, 20000000,
    ]) {
      if (price === 1) continue; // A sub-kobo platform fee cannot be collected.
      const value = totals(price);
      expect(value.buyerPaystackFeeKobo).toBe(paystackFeeKobo(value.totalKobo));
      expect(value.groupNetKobo).toBe(price);
    }
    expect(totals(233400).totalKobo).toBeLessThan(250000);
    expect(totals(20000000).buyerPaystackFeeKobo).toBe(200000);
  });
  it("rejects missing/invalid fees, unsafe money and negative group proceeds", () => {
    for (const percent of [undefined, 0, -1, 101, 0.001])
      expect(() => totals(250000, { platformFeePercent: percent })).toThrow();
    expect(() => totals(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() =>
      totals(250000, {
        platformFeePercent: 100,
        platformFeeMode: "deducted_from_group",
        paystackFeeBearer: "group",
      }),
    ).toThrow();
  });
});
