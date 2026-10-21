// Revenue is earned group proceeds, not proof that a bank payout has completed.
// Test-only orders retain zero actual settlement shares; reports use their frozen policy quote.
export const quotedGroupNet = {
  $ifNull: [
    "$groupNetKobo",
    {
      $ifNull: [
        "$feeBreakdown.groupNetKobo",
        { $subtract: ["$amountKobo", "$feeKobo"] },
      ],
    },
  ],
};
export const orderNetRevenue = {
  $cond: [
    { $eq: ["$settlementMode", "test_unsplit"] },
    quotedGroupNet,
    { $ifNull: ["$actualGroupNetKobo", quotedGroupNet] },
  ],
};
export const testPayment = {
  $or: [
    { $eq: ["$settlementDomain", "test"] },
    { $eq: ["$settlementMode", "test_unsplit"] },
  ],
};
export const countedSale = {
  $and: [{ $eq: ["$status", "paid"] }, { $ne: ["$paymentReview", true] }],
};
