// PAY-*, ANA-028, TKT-020. Read-only saved payments; no provider keys or populated cookies.
export const variables = { financeFrom: "2000-01-01", financeTo: "2100-12-31" };
const query =
  "/api/admin/transactions?from={{financeFrom}}&to={{financeTo}}&status=all";
const summary = {
  grossKobo: 127919,
  previousGrossKobo: 0,
  ticketSalesKobo: 120000,
  previousTicketSalesKobo: 0,
  feesKobo: 1919,
  platformFeesKobo: 6000,
  netKobo: 120000,
  testNetKobo: 120000,
  refundsKobo: 0,
  refundCount: 0,
  refundRequests: 0,
  pendingCount: 0,
  failedCount: 0,
};
const example = {
  items: [
    {
      reference: "HIP-example",
      ticketCode: "HIP-ABCD-1234",
      ticketCodes: ["HIP-ABCD-1234"],
      ticketCount: 1,
      buyerName: "Guest Hiker",
      buyerEmail: "buyer@example.test",
      eventId: "example-event",
      eventTitle: "Example hike",
      ticketKobo: 120000,
      feeKobo: 1919,
      platformFeeKobo: 6000,
      netKobo: 120000,
      amountKobo: 127919,
      status: "successful",
      paymentReview: false,
      paymentMode: "test",
      settlementMode: "test_unsplit",
      createdAt: "2026-10-21T10:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 10,
  summary,
};
const assertions = [
  'pm.test("Direct transactions contract", function () { pm.expect(Object.keys(body).sort()).to.deep.eql(["items","total","page","pageSize","summary"].sort()); });',
  'pm.test("Integer kobo and real counts", function () { for(const value of Object.values(body.summary)) pm.expect(Number.isSafeInteger(value) && value >= 0).to.eql(true); });',
  'pm.test("One row per order reference", function () { pm.expect(new Set(body.items.map(r=>r.reference)).size).to.eql(body.items.length); });',
  'pm.test("Only authorised reporting fields", function () { pm.expect(/ownerHash|requestHash|accessCode|qrToken|subaccountCode|deliveryPayload|privateKey/.test(JSON.stringify(body))).to.eql(false); });',
  'pm.test("Test payments identified separately from settlement", function () { body.items.forEach(r=>{if(r.settlementMode === "test_unsplit") pm.expect(r.paymentMode).to.eql("test");}); });',
];
const item = (
  number,
  label,
  path,
  cookieVar = "managerCookie",
  status = 200,
  code,
  message,
) => ({
  name: `T${String(number).padStart(2, "0")} PAY-* — ${label}`,
  transactionsController: true,
  method: "GET",
  path,
  cookieVar,
  expected: {
    status,
    body: status === 200 ? example : { message, success: false, status, code },
  },
  ...(status === 200 ? { overviewAssertions: assertions } : {}),
});
export const cases = [
  item(1, "list recorded payments and all fee totals", query),
  item(2, "ordinary admin can read payments", query, "overviewAdminCookie"),
  item(
    3,
    "filter successful payments",
    query.replace("status=all", "status=successful"),
  ),
  item(4, "second page preserves summary totals", query + "&page=2"),
  item(5, "CSV reads every matching row", query + "&all=true"),
  item(
    6,
    "literal bracket search never becomes a regular expression",
    query + "&q=%5B",
  ),
  item(
    7,
    "check-in staff cannot read payments",
    query,
    "overviewCheckinCookie",
    403,
    "forbidden",
    "You don’t have permission to do that.",
  ),
  item(
    8,
    "advertiser cannot read payments",
    query,
    "overviewAdvertiserCookie",
    403,
    "forbidden",
    "You don’t have permission to do that.",
  ),
  item(
    9,
    "setup-only session cannot read payments",
    query,
    "overviewSetupCookie",
    403,
    "two_step_required",
    "Set up your authenticator to finish signing in.",
  ),
  item(
    10,
    "signed-out request cannot read payments",
    query,
    undefined,
    401,
    "unauthenticated",
    "Please sign in as staff to continue.",
  ),
  item(
    11,
    "invalid date is a field error",
    query.replace("{{financeFrom}}", "2026-02-30"),
    "managerCookie",
    400,
    "validation_error",
    "Choose a valid date",
  ),
  item(
    12,
    "unknown ticket is not found",
    "/api/admin/tickets/HIP-NONE-NONE",
    "managerCookie",
    404,
    "not_found",
    "Ticket not found.",
  ),
];
cases[9].cookieVar = undefined;

cases[10].expected.body.field = "from";
