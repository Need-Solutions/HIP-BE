// TKT-006–TKT-018. No provider secret belongs in Postman. Use a private environment for cookies/guest links.
export const variables = {
  checkoutManagerCookie: "",
  checkoutAdminCookie: "",
  settlementBankCode: "",
  settlementAccountNumber: "",
  settlementAccountName: "",
  checkoutFreeEventId: "",
  checkoutFreeTypeId: "",
  checkoutPaidEventId: "",
  checkoutPaidTypeId: "",
  checkoutCookie: "",
  guestTicketCookie: "",
  guestTicketToken: "",
  localHoldId: "",
  localCheckoutId: "",
  localReference: "",
  freeHoldId: "",
  paidHoldId: "",
  expiryHoldId: "",
  freeCheckoutId: "",
  paidCheckoutId: "",
  expiryCheckoutId: "",
  freeReference: "",
  paidReference: "",
  freeTicketCode: "",
  paidTicketCode: "",
  paystackAccessCode: "",
  checkoutName: "Guest Hiker",
  checkoutEmail: "",
  checkoutPhone: "",
  checkoutEmergencyName: "Emergency contact",
  checkoutEmergencyPhone: "",
};
const check = (label, expression) =>
  `pm.test(${JSON.stringify(label)}, function () { pm.expect(Boolean(${expression})).to.eql(true); });`;
const failure = (status, code, message) => ({
  status,
  body: { message, success: false, status, code },
});
const checkout = (prefix) => ({
  holdId: `{{${prefix}HoldId}}`,
  eventId: `{{checkout${prefix === "free" ? "Free" : "Paid"}EventId}}`,
  items: [
    {
      ticketTypeId: `{{checkout${prefix === "free" ? "Free" : "Paid"}TypeId}}`,
      quantity: 1,
    },
  ],
  buyer: {
    fullName: "{{checkoutName}}",
    email: "{{checkoutEmail}}",
    phone: "{{checkoutPhone}}",
  },
  attendees: [
    {
      ticketTypeId: `{{checkout${prefix === "free" ? "Free" : "Paid"}TypeId}}`,
      fullName: "{{checkoutName}}",
      email: "{{checkoutEmail}}",
      phone: "{{checkoutPhone}}",
    },
  ],
  emergencyContact: {
    name: "{{checkoutEmergencyName}}",
    phone: "{{checkoutEmergencyPhone}}",
  },
  createAccount: false,
  whatsappReminders: false,
  paymentChannel: "card",
});
const feeExample = (paid) => ({
  platformFeePercent: 5,
  platformFeeMode: "added_to_buyer",
  platformFeeOnRefund: "refund",
  paystackFeeBearer: "hiker",
  subtotalKobo: paid ? 250000 : 0,
  platformFeeKobo: paid ? 12500 : 0,
  paystackFeeKobo: paid ? 14150 : 0,
  buyerPlatformFeeKobo: paid ? 12500 : 0,
  buyerPaystackFeeKobo: paid ? 14150 : 0,
  groupNetKobo: paid ? 250000 : 0,
  totalKobo: paid ? 276650 : 0,
});
const startExample = (prefix, paid) => ({
  checkoutId: `{{${prefix}CheckoutId}}`,
  reference: `{{${prefix}Reference}}`,
  ...(paid ? { paystackAccessCode: "{{paystackAccessCode}}" } : {}),
  amountKobo: paid ? 276650 : 0,
  feeBreakdown: feeExample(paid),
});
const holdExample = (prefix) => ({
  holdId: `{{${prefix}HoldId}}`,
  expiresAt: "2026-11-01T09:10:00.000Z",
});
const ticketExample = (paid = false) => ({
  id: "ticket-id",
  code: paid ? "{{paidTicketCode}}" : "{{freeTicketCode}}",
  eventId: paid ? "{{checkoutPaidEventId}}" : "{{checkoutFreeEventId}}",
  ticketTypeId: paid ? "{{checkoutPaidTypeId}}" : "{{checkoutFreeTypeId}}",
  holder: {
    fullName: "{{checkoutName}}",
    email: "{{checkoutEmail}}",
    phone: "{{checkoutPhone}}",
  },
  isGuest: true,
  paymentId: paid ? "{{paidReference}}" : "{{freeReference}}",
  qrToken: "HIP-XXXX-XXXX.event-id.base64url-signature",
  status: "confirmed",
  issuedAt: "2026-11-01T09:00:00.000Z",
  ticketTypeName: paid ? "Standard" : "Community",
  event: {
    id: paid ? "{{checkoutPaidEventId}}" : "{{checkoutFreeEventId}}",
    slug: "checkout-hike",
    title: "Checkout verification hike",
    startsAt: "2026-11-08T05:00:00.000Z",
    durationLabel: "About 3 hrs",
    meetingPoint: "Park gate",
    location: "Abuja",
  },
});
const statusExample = (paid, status = "paid") => ({
  status,
  reference: paid ? "{{paidReference}}" : "{{freeReference}}",
  amountKobo: paid ? 276650 : 0,
  feeBreakdown: feeExample(paid),
  isGuest: true,
  buyer: {
    fullName: "{{checkoutName}}",
    email: "{{checkoutEmail}}",
    phone: "{{checkoutPhone}}",
  },
  accountCreated: false,
  tickets: status === "paid" ? [ticketExample(paid)] : [],
});
const exactKeys = (keys) =>
  check(
    "Exact checkout response fields (optional server test-mode label)",
    `(!('settlementMode' in body) || body.settlementMode === 'test_unsplit') && JSON.stringify(Object.keys(body).filter(key => key !== "settlementMode").sort()) === JSON.stringify(${JSON.stringify(keys.sort())})`,
  );
const statusChecks = (status, paid) => [
  exactKeys([
    "status",
    "reference",
    "amountKobo",
    "feeBreakdown",
    "isGuest",
    "buyer",
    "accountCreated",
    "tickets",
  ]),
  check(
    "Payment state and server amount",
    `body.status === ${JSON.stringify(status)} && body.amountKobo === ${paid ? 276650 : 0} && body.isGuest === true && body.accountCreated === false`,
  ),
  check(
    "One ticket only after verification",
    status === "paid"
      ? 'body.tickets.length === 1 && /^HIP-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(body.tickets[0].code) && body.tickets[0].qrToken.split(".").length === 3'
      : "body.tickets.length === 0",
  ),
  check(
    "Private fields excluded",
    "!/passwordHash|privateKey|ownerHash|deliveryPayload|accessCode/.test(JSON.stringify(body))",
  ),
];
let number = 0;
const item = (label, method, path, body, expected, extra = {}) => ({
  name: `F${String(++number).padStart(2, "0")} TKT-006–TKT-018 — ${label}`,
  checkoutController: true,
  method,
  path,
  ...(body ? { body } : {}),
  expected,
  cookieVar: "checkoutCookie",
  ...extra,
});
const hold = (label, prefix) =>
  item(
    label,
    "POST",
    "/api/checkout/holds",
    {
      eventId: `{{checkout${prefix === "free" ? "Free" : "Paid"}EventId}}`,
      items: [
        {
          ticketTypeId: `{{checkout${prefix === "free" ? "Free" : "Paid"}TypeId}}`,
          quantity: 1,
        },
      ],
    },
    { status: 200, body: holdExample(prefix) },
    {
      captureCheckoutCookie: true,
      capture: { [`${prefix}HoldId`]: "holdId" },
      checkoutAssertions: [
        exactKeys(["holdId", "expiresAt"]),
        check(
          "Ten-minute hold",
          "Date.parse(body.expiresAt) > Date.now() && Date.parse(body.expiresAt) <= Date.now() + 600000",
        ),
      ],
    },
  );
const start = (label, prefix, paid) =>
  item(
    label,
    "POST",
    "/api/checkout",
    checkout(prefix),
    { status: 200, body: startExample(prefix, paid) },
    {
      capture: {
        [`${prefix}CheckoutId`]: "checkoutId",
        [`${prefix}Reference`]: "reference",
        ...(paid ? { paystackAccessCode: "paystackAccessCode" } : {}),
      },
      checkoutAssertions: [
        exactKeys([
          "checkoutId",
          "reference",
          "amountKobo",
          "feeBreakdown",
          ...(paid ? ["paystackAccessCode"] : []),
        ]),
        check(
          "Server fee breakdown",
          "body.feeBreakdown.totalKobo === body.amountKobo && body.feeBreakdown.totalKobo === body.feeBreakdown.groupNetKobo + body.feeBreakdown.platformFeeKobo + body.feeBreakdown.paystackFeeKobo",
        ),
        check("Server total", `body.amountKobo === ${paid ? 276650 : 0}`),
      ],
      ...(paid ? { visualizePayment: true } : {}),
    },
  );
export const cases = [
  hold("hold the free seat", "free"),
  start("free order skips Paystack", "free", false),
  item(
    "free order is paid with a signed ticket",
    "GET",
    "/api/checkout/{{freeCheckoutId}}",
    undefined,
    { status: 200, body: statusExample(false) },
    {
      capture: { freeTicketCode: "tickets.0.code" },
      checkoutAssertions: statusChecks("paid", false),
    },
  ),
  item(
    "repeat free start without duplicate issuance",
    "POST",
    "/api/checkout",
    checkout("free"),
    { status: 200, body: startExample("free", false) },
    {
      checkoutAssertions: [
        check(
          "Same order",
          'body.checkoutId === pm.variables.get("freeCheckoutId") && body.reference === pm.variables.get("freeReference") && body.amountKobo === 0',
        ),
      ],
    },
  ),
  item(
    "find a known guest ticket",
    "POST",
    "/api/tickets/guest-link",
    { contact: "{{checkoutEmail}}", code: "{{freeTicketCode}}" },
    { status: 204 },
  ),
  item(
    "unknown email gets the same reply",
    "POST",
    "/api/tickets/guest-link",
    { contact: "not-a-buyer@example.com" },
    { status: 204 },
  ),
  item(
    "redeem the emailed one-time guest link in a fresh browser",
    "GET",
    "/api/tickets/{{freeTicketCode}}?token={{guestTicketToken}}",
    undefined,
    { status: 200, body: ticketExample() },
    {
      cookieVar: undefined,
      captureCheckoutCookie: "guestTicketCookie",
      checkoutAssertions: [
        check(
          "Expected ticket",
          'body.code === pm.variables.get("freeTicketCode") && body.qrToken.split(".").length === 3',
        ),
      ],
    },
  ),
  item(
    "the same token cannot authorize another browser",
    "GET",
    "/api/tickets/{{freeTicketCode}}?token={{guestTicketToken}}",
    undefined,
    failure(404, "not_found", "Ticket not found."),
    { cookieVar: undefined },
  ),
  item(
    "redeemed browser can refresh without a token",
    "GET",
    "/api/tickets/{{freeTicketCode}}",
    undefined,
    { status: 200, body: ticketExample() },
    {
      cookieVar: "guestTicketCookie",
      checkoutAssertions: [
        check(
          "Expected ticket",
          'body.code === pm.variables.get("freeTicketCode")',
        ),
      ],
    },
  ),
  hold("hold a paid seat", "paid"),
  start("initialize the paid order at NGN 2766.50", "paid", true),
  item(
    "poll before paying: pending, no tickets",
    "GET",
    "/api/checkout/{{paidCheckoutId}}",
    undefined,
    { status: 200, body: statusExample(true, "pending") },
    { checkoutAssertions: statusChecks("pending", true) },
  ),
  item(
    "resume uses the same reference and payment session",
    "POST",
    "/api/checkout/{{paidCheckoutId}}/resume",
    {},
    { status: 200, body: startExample("paid", true) },
    {
      visualizePayment: true,
      checkoutAssertions: [
        check(
          "No second payment reference",
          'body.reference === pm.variables.get("paidReference") && body.paystackAccessCode === pm.variables.get("paystackAccessCode") && body.amountKobo === 276650',
        ),
      ],
    },
  ),
  item(
    "pay with the test card, then poll for verified tickets",
    "GET",
    "/api/checkout/{{paidCheckoutId}}",
    undefined,
    { status: 200, body: statusExample(true) },
    {
      completePaymentBefore: true,
      capture: { paidTicketCode: "tickets.0.code" },
      checkoutAssertions: statusChecks("paid", true),
    },
  ),
  item(
    "repeated polling returns the same ticket",
    "GET",
    "/api/checkout/{{paidCheckoutId}}",
    undefined,
    { status: 200, body: statusExample(true) },
    {
      checkoutAssertions: [
        ...statusChecks("paid", true),
        check(
          "Same ticket",
          'body.tickets[0].code === pm.variables.get("paidTicketCode")',
        ),
      ],
    },
  ),
  item(
    "buyer browser opens its ticket",
    "GET",
    "/api/tickets/{{paidTicketCode}}",
    undefined,
    { status: 200, body: ticketExample(true) },
    {
      checkoutAssertions: [
        check(
          "Expected ticket",
          'body.code === pm.variables.get("paidTicketCode")',
        ),
      ],
    },
  ),
  item(
    "another browser cannot look up the order",
    "GET",
    "/api/checkout/{{paidCheckoutId}}",
    undefined,
    failure(404, "not_found", "Checkout not found"),
    { cookieVar: undefined },
  ),
  item(
    "more than ten tickets is rejected",
    "POST",
    "/api/checkout/holds",
    {
      eventId: "{{checkoutPaidEventId}}",
      items: [{ ticketTypeId: "{{checkoutPaidTypeId}}", quantity: 11 }],
    },
    {
      status: 400,
      body: {
        ...failure(
          400,
          "validation_error",
          "You can buy up to 10 tickets in one order.",
        ).body,
        field: "items.0.quantity",
      },
    },
  ),
  item(
    "the free event is sold out",
    "POST",
    "/api/checkout/holds",
    {
      eventId: "{{checkoutFreeEventId}}",
      items: [{ ticketTypeId: "{{checkoutFreeTypeId}}", quantity: 1 }],
    },
    failure(
      409,
      "sold_out",
      "Those tickets are sold out or no longer on sale.",
    ),
  ),
  hold("hold the last paid seat for the expiry check", "expiry"),
  start("start an unpaid order for the expiry check", "expiry", true),
  item(
    "wait ten minutes: resume returns 410",
    "POST",
    "/api/checkout/{{expiryCheckoutId}}/resume",
    {},
    failure(
      410,
      "hold_expired",
      "Your seat hold has expired. Please start again.",
    ),
    { expireHoldBefore: "expiryHoldId" },
  ),
  item(
    "an expired hold cannot start another order",
    "POST",
    "/api/checkout",
    {
      ...checkout("expiry"),
      buyer: {
        fullName: "Different buyer",
        email: "{{checkoutEmail}}",
        phone: "{{checkoutPhone}}",
      },
    },
    failure(
      410,
      "hold_expired",
      "Your seat hold has expired. Please start again.",
    ),
  ),
  item(
    "browser-supplied totals are rejected",
    "POST",
    "/api/checkout",
    { ...checkout("paid"), amountKobo: 1 },
    {
      status: 400,
      body: failure(
        400,
        "validation_error",
        "Unrecognized key(s) in object: 'amountKobo'",
      ).body,
    },
  ),
  item(
    "a bad webhook signature never issues tickets",
    "POST",
    "/api/webhooks/paystack",
    {
      event: "charge.success",
      data: { reference: "{{paidReference}}", amount: 1, currency: "NGN" },
    },
    failure(401, "invalid_signature", "Invalid webhook signature."),
    { badWebhook: true, cookieVar: undefined },
  ),
];
export const initialize = [
  "// Before running: prepare published free (capacity 1, Community free x1) and paid (capacity 2, Standard 250000 kobo x2) events in Controller 5. Set their IDs and a disposable inbox privately.",
  "// Copy guestTicketToken from the recovery email before F07. Open F11/F13 Visualize only after F12; complete payment before F14. Wait until expiry before F22.",
];

const policy = {
  platformFeePercent: 5,
  platformFeeMode: "added_to_buyer",
  platformFeeOnRefund: "refund",
  paystackFeeBearer: "hiker",
};
const settingsExample = {
  ...policy,
  paymentMode: "test",
  paidCheckoutReady: false,
  settlement: null,
};
const settingsCase = (label, method, path, body, expected, extra = {}) =>
  item(label, method, path, body, expected, {
    cookieVar: "checkoutManagerCookie",
    ...extra,
  });
const setupCases = [
  item(
    "paid order refused without group settlement",
    "POST",
    "/api/checkout",
    checkout("paid"),
    failure(
      503,
      "settlement_not_configured",
      "Paid checkout is unavailable until the group settlement account is configured.",
    ),
  ),
  settingsCase(
    "read persisted fee settings",
    "GET",
    "/api/admin/checkout/settings",
    undefined,
    { status: 200, body: settingsExample },
    {
      checkoutAssertions: [
        check(
          "Settings have policy and readiness",
          "body.platformFeeMode === 'added_to_buyer' && body.paidCheckoutReady === false && body.settlement === null",
        ),
      ],
    },
  ),
  settingsCase(
    "save the illustrative five percent fee policy",
    "PUT",
    "/api/admin/checkout/settings",
    policy,
    { status: 200, body: settingsExample },
    {
      checkoutAssertions: [
        check(
          "Fee policy saved",
          "body.platformFeePercent === 5 && body.platformFeeOnRefund === 'refund' && body.paystackFeeBearer === 'hiker'",
        ),
      ],
    },
  ),
  settingsCase(
    "reject a zero fee",
    "PUT",
    "/api/admin/checkout/settings",
    { ...policy, platformFeePercent: 0 },
    {
      status: 400,
      body: {
        ...failure(400, "validation_error", "Enter a percentage above zero")
          .body,
        field: "platformFeePercent",
      },
    },
  ),
  settingsCase(
    "save local test bank details without either Paystack call",
    "POST",
    "/api/admin/checkout/subaccount",
    {
      bankCode: "{{settlementBankCode}}",
      accountNumber: "{{settlementAccountNumber}}",
      accountName: "{{settlementAccountName}}",
    },
    {
      status: 200,
      body: {
        ...settingsExample,
        paidCheckoutReady: true,
        settlement: {
          subaccountCode: null,
          localTestOnly: true,
          domain: "test",
          bankCode: "{{settlementBankCode}}",
          accountName: "{{settlementAccountName}}",
          accountLast4: "0000",
          accountVerified: false,
        },
      },
    },
    {
      checkoutAssertions: [
        check(
          "Local test bank details enable test payments without settlement",
          "body.paidCheckoutReady === true && body.settlement.localTestOnly === true && body.settlement.subaccountCode === null && body.settlement.domain === 'test' && body.settlement.accountVerified === false && body.settlement.accountName === pm.variables.get('settlementAccountName')",
        ),
      ],
    },
  ),
  settingsCase(
    "explicitly register a provider-backed test subaccount",
    "POST",
    "/api/admin/checkout/subaccount",
    {
      bankCode: "{{settlementBankCode}}",
      accountNumber: "{{settlementAccountNumber}}",
      accountName: "{{settlementAccountName}}",
      registerWithPaystack: true,
    },
    {
      status: 200,
      body: {
        ...settingsExample,
        paidCheckoutReady: true,
        settlement: {
          subaccountCode: "ACCT_example",
          localTestOnly: false,
          domain: "test",
          bankCode: "{{settlementBankCode}}",
          accountName: "{{settlementAccountName}}",
          accountLast4: "0000",
          accountVerified: false,
        },
      },
    },
    {
      checkoutAssertions: [
        check(
          "Unverified masked test settlement account",
          "body.paidCheckoutReady === true && body.settlement.localTestOnly === false && /^ACCT_/.test(body.settlement.subaccountCode) && body.settlement.domain === 'test' && body.settlement.accountVerified === false && !JSON.stringify(body).includes('accountNumber')",
        ),
      ],
    },
  ),
  settingsCase(
    "ordinary admin cannot change fees",
    "PUT",
    "/api/admin/checkout/settings",
    policy,
    failure(403, "forbidden", "You don’t have permission to do that."),
    { cookieVar: "checkoutAdminCookie" },
  ),
  item(
    "quote the server fee breakdown",
    "POST",
    "/api/checkout/quote",
    {
      eventId: "{{checkoutPaidEventId}}",
      items: [{ ticketTypeId: "{{checkoutPaidTypeId}}", quantity: 1 }],
    },
    {
      status: 200,
      body: { amountKobo: 276650, feeBreakdown: feeExample(true) },
    },
    {
      checkoutAssertions: [
        check(
          "Server quote includes platform fee and group share",
          "body.feeBreakdown.platformFeeKobo === 12500 && body.feeBreakdown.groupNetKobo === 250000 && body.amountKobo === 276650",
        ),
      ],
    },
  ),
];
const localQuote = item(
  "quote a test payment without bank settlement",
  "POST",
  "/api/checkout/quote",
  {
    eventId: "{{checkoutPaidEventId}}",
    items: [{ ticketTypeId: "{{checkoutPaidTypeId}}", quantity: 1 }],
  },
  {
    status: 200,
    body: {
      amountKobo: 276650,
      feeBreakdown: feeExample(true),
      settlementMode: "test_unsplit",
    },
  },
  {
    checkoutAssertions: [
      check(
        "Clearly labelled test quote",
        "body.settlementMode === 'test_unsplit' && body.amountKobo === 276650",
      ),
    ],
  },
);
const localHold = hold(
  "hold a seat for test payment without settlement",
  "local",
);
const localStart = start(
  "initialize a real test payment without split settlement",
  "local",
  true,
);
localStart.body = { ...checkout("paid"), holdId: "{{localHoldId}}" };
localStart.expected.body.settlementMode = "test_unsplit";
localStart.checkoutAssertions.push(
  check("Test payment label", "body.settlementMode === 'test_unsplit'"),
);
const localChecks = [
  check("Test payment label", "body.settlementMode === 'test_unsplit'"),
];
const localCases = [
  localHold,
  localStart,
  item(
    "test payment remains pending before provider verification",
    "GET",
    "/api/checkout/{{localCheckoutId}}",
    undefined,
    {
      status: 200,
      body: {
        ...statusExample(true, "pending"),
        reference: "{{localReference}}",
        settlementMode: "test_unsplit",
      },
    },
    { checkoutAssertions: [...statusChecks("pending", true), ...localChecks] },
  ),
  item(
    "resume test payment without settlement",
    "POST",
    "/api/checkout/{{localCheckoutId}}/resume",
    {},
    { status: 200, body: localStart.expected.body },
    { checkoutAssertions: localStart.checkoutAssertions },
  ),
  item(
    "verify test payment and issue tickets once without claiming settlement",
    "GET",
    "/api/checkout/{{localCheckoutId}}",
    undefined,
    {
      status: 200,
      body: {
        ...statusExample(true),
        reference: "{{localReference}}",
        settlementMode: "test_unsplit",
      },
    },
    {
      completePaymentBefore: true,
      confirmationReferenceVar: "localReference",
      checkoutAssertions: [...statusChecks("paid", true), ...localChecks],
    },
  ),
  item(
    "repeat verified test payment without duplicate tickets",
    "GET",
    "/api/checkout/{{localCheckoutId}}",
    undefined,
    {
      status: 200,
      body: {
        ...statusExample(true),
        reference: "{{localReference}}",
        settlementMode: "test_unsplit",
      },
    },
    { checkoutAssertions: [...statusChecks("paid", true), ...localChecks] },
  ),
];
cases.splice(
  10,
  0,
  setupCases[1],
  setupCases[2],
  setupCases[3],
  setupCases[0],
  setupCases[4],
  localQuote,
  ...localCases,
  ...setupCases.slice(5),
);
