// Controller 7. Populate only a private environment; exported defaults contain no real data.
export const variables = Object.fromEntries(
  [
    "accountEmail",
    "accountPassword",
    "accountCookie",
    "accountOtherCookie",
    "accountTicketCode",
    "accountPastTicketCode",
    "accountForeignTicketCode",
    "accountFreeTicketCode",
    "accountCheckedInCode",
    "accountLateCode",
    "accountPhotoFile",
    "accountWrongPhotoFile",
    "accountLargePhotoFile",
    "accountDeleteEmail",
    "accountDeletePassword",
    "accountDeleteCookie",
  ].map((key) => [key, ""]),
);
const fail = (status, code, message, details = {}) => ({
  status,
  body: { message, success: false, status, code, ...details },
});
const errorChecks = (code) => [
  `pm.test("Error contract", function () { pm.expect(body.success).to.eql(false); pm.expect(body.status).to.eql(pm.response.code); pm.expect(body.code).to.eql(${JSON.stringify(code)}); pm.expect(typeof body.message).to.eql("string"); });`,
];
const item = (name, method, path, body, expected, checks = [], extra = {}) => ({
  name,
  method,
  path,
  ...(body ? { body } : {}),
  expected,
  accountController: true,
  cookieVar: "accountCookie",
  accountAssertions:
    expected.status >= 400 ? errorChecks(expected.body.code) : checks,
  ...extra,
});
const page = {
  tickets: [],
  pending: [],
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 0,
  counts: {
    upcoming: 0,
    upcomingBoughtForOthers: 0,
    past: 0,
    cancelled: 0,
    pending: 0,
  },
};
const listChecks = [
  'pm.test("Account page", function () { pm.expect(Array.isArray(body.tickets)).to.eql(true); pm.expect(Array.isArray(body.pending)).to.eql(true); pm.expect(typeof body.total).to.eql("number"); ["upcoming", "upcomingBoughtForOthers", "past", "cancelled", "pending"].forEach(k => pm.expect(Number.isInteger(body.counts[k])).to.eql(true)); body.tickets.forEach(t => { pm.expect(t.heldByMe || t.boughtByMe).to.eql(true); pm.expect(typeof t.code).to.eql("string"); }); });',
];
const loginChecks = (cookie) => [
  'pm.test("Hiker login", function () { pm.expect(body.roles).to.include("hiker"); pm.expect(body.passwordHash).to.eql(undefined); pm.expect(body.photoUrl === null || typeof body.photoUrl === "string").to.eql(true); });',
  'const session = pm.response.headers.all().find(h => h.key.toLowerCase() === "set-cookie" && h.value.startsWith("hip_session="));',
  `if (session) pm.environment.set(${JSON.stringify(cookie)}, session.value.split(";")[0]);`,
];
const refundExample = {
  status: "requested",
  amountKobo: 105000,
  requestedAt: "<UTC ISO date>",
  reason: "Unable to attend",
};
export const cases = [
  item(
    "G01 AUTH-012 — log in as the disposable hiker",
    "POST",
    "/api/auth/user-login",
    {
      identifier: "{{accountEmail}}",
      password: "{{accountPassword}}",
      remember: false,
    },
    {
      status: 200,
      body: { id: "<user ID>", roles: ["hiker"], fullName: "Test hiker" },
    },
    loginChecks("accountCookie"),
    { cookieVar: undefined },
  ),
  ...["upcoming", "past", "cancelled"].map((tab, i) =>
    item(
      `G0${i + 2} TKT-016 — ${tab} tickets, holders and buyers`,
      "GET",
      `/api/me/tickets?tab=${tab}&page=1&pageSize=20`,
      null,
      { status: 200, body: page },
      listChecks,
    ),
  ),
  item(
    "G05 TKT-016 — second page",
    "GET",
    "/api/me/tickets?tab=upcoming&page=2&pageSize=1",
    null,
    { status: 200, body: { ...page, page: 2, pageSize: 1 } },
    listChecks,
  ),
  item(
    "G06 TKT-014 — own ticket and QR",
    "GET",
    "/api/me/tickets/{{accountTicketCode}}",
    null,
    {
      status: 200,
      body: {
        code: "{{accountTicketCode}}",
        qrToken: "<signed QR>",
        status: "confirmed",
      },
    },
    [
      'pm.test("Owned ticket", function () { pm.expect(body.code).to.eql(pm.variables.get("accountTicketCode")); pm.expect(typeof body.qrToken).to.eql("string"); pm.expect(typeof body.heldByMe).to.eql("boolean"); pm.expect(typeof body.boughtByMe).to.eql("boolean"); pm.expect(Number.isSafeInteger(body.pricePaidKobo)).to.eql(true); pm.expect(typeof body.holder.fullName).to.eql("string"); pm.expect(typeof body.event.slug).to.eql("string"); });',
    ],
  ),
  item(
    "G06b AUTH-016 — session avatar follows photo changes",
    "GET",
    "/api/auth/me",
    null,
    { status: 200, body: { photoUrl: null } },
    [
      'pm.test("Session photo", function () { pm.expect(body.photoUrl === null || typeof body.photoUrl === "string").to.eql(true); pm.expect(body.photoPublicId).to.eql(undefined); });',
    ],
  ),
  item(
    "G07 TKT-021 — quote without creating a request",
    "GET",
    "/api/me/refund-quote/{{accountTicketCode}}",
    null,
    {
      status: 200,
      body: {
        eligible: true,
        percent: 100,
        amount: 105000,
        platformFeeRefunded: 5000,
        reason: null,
      },
    },
    [
      'pm.test("Refund quote in kobo", function () { pm.expect(body.eligible).to.eql(true); pm.expect([50,100]).to.include(body.percent); pm.expect(Number.isSafeInteger(body.amount)).to.eql(true); });',
    ],
  ),
  item(
    "G08 TKT-021 — request refund",
    "POST",
    "/api/me/tickets/{{accountTicketCode}}/refund-request",
    { reason: "Unable to attend" },
    { status: 200, body: refundExample },
    [
      'pm.test("Pending refund", function () { pm.expect(body.status).to.eql("requested"); pm.expect(Number.isSafeInteger(body.amountKobo)).to.eql(true); });',
    ],
  ),
  item(
    "G09 TKT-014 — requested refund has no QR",
    "GET",
    "/api/me/tickets/{{accountTicketCode}}",
    null,
    {
      status: 200,
      body: {
        code: "{{accountTicketCode}}",
        status: "pending",
        qrToken: "",
        refund: refundExample,
      },
    },
    [
      'pm.test("QR blocked pending refund", function () { pm.expect(body.qrToken).to.eql(""); pm.expect(body.refund.status).to.eql("requested"); });',
    ],
  ),
  item(
    "G10 TKT-021 — duplicate refund refused",
    "POST",
    "/api/me/tickets/{{accountTicketCode}}/refund-request",
    { reason: "Unable to attend" },
    fail(
      409,
      "REFUND_NOT_ALLOWED",
      "A refund request already exists for this ticket.",
    ),
  ),
  ...[
    ["G11", "accountFreeTicketCode", "free ticket"],
    ["G12", "accountCheckedInCode", "already checked in"],
    ["G13", "accountLateCode", "check-in has opened"],
  ].map(([number, code, label]) =>
    item(
      `${number} TKT-021 — refuse ${label}`,
      "POST",
      `/api/me/tickets/{{${code}}}/refund-request`,
      { reason: "Unable to attend" },
      fail(409, "REFUND_NOT_ALLOWED", "This ticket cannot be refunded."),
    ),
  ),
  item(
    "G14 TKT-014 — other user's ticket is hidden",
    "GET",
    "/api/me/tickets/{{accountForeignTicketCode}}",
    null,
    fail(404, "not_found", "Ticket not found."),
  ),
  item(
    "G15 TKT-021 — malformed reason",
    "POST",
    "/api/me/tickets/{{accountPastTicketCode}}/refund-request",
    { reason: "" },
    fail(400, "validation_error", "Tell us why you need a refund", {
      field: "reason",
    }),
  ),
  item(
    "G16 HIS-001 — history array",
    "GET",
    "/api/me/history",
    null,
    { status: 200, body: [] },
    [
      'pm.test("History array", function () { pm.expect(Array.isArray(body)).to.eql(true); body.filter(e=>e.outcome==="attended").forEach(e=>pm.expect(Boolean(e.checkIn)).to.eql(true)); });',
    ],
  ),
  item(
    "G17 HIS-001 — history totals",
    "GET",
    "/api/me/history?includeTotals=true",
    null,
    {
      status: 200,
      body: {
        entries: [],
        totals: { hikesAttended: 0, uniqueTrails: 0, mostRecentHike: null },
      },
    },
    [
      'pm.test("Check-in totals", function () { pm.expect(Array.isArray(body.entries)).to.eql(true); pm.expect(Number.isInteger(body.totals.hikesAttended)).to.eql(true); });',
    ],
  ),
  item(
    "G18 AUTH-016 — upload or replace photo",
    "POST",
    "/api/me/photo",
    null,
    {
      status: 200,
      body: {
        photoUrl: "https://res.cloudinary.com/<cloud>/image/upload/<avatar>",
        user: { id: "<user ID>" },
      },
    },
    [
      'pm.test("Public photo only", function () { pm.expect(body.photoUrl.startsWith("https://")).to.eql(true); pm.expect(body.photoPublicId).to.eql(undefined); pm.expect(body.user.photoUrl).to.eql(body.photoUrl); });',
    ],
    { multipart: "accountPhotoFile" },
  ),
  item(
    "G19 AUTH-016 — wrong photo type",
    "POST",
    "/api/me/photo",
    null,
    fail(400, "invalid_file_type", "Choose a JPG, PNG or WebP image.", {
      field: "image",
    }),
    [],
    { multipart: "accountWrongPhotoFile" },
  ),
  item(
    "G20 AUTH-016 — photo too large",
    "POST",
    "/api/me/photo",
    null,
    fail(413, "file_too_large", "Choose an image no larger than 5 MB.", {
      field: "image",
    }),
    [],
    { multipart: "accountLargePhotoFile" },
  ),
  item(
    "G21 AUTH-016 — remove photo",
    "DELETE",
    "/api/me/photo",
    null,
    {
      status: 200,
      body: {
        user: { id: "<user ID>" },
        hikesAttended: 0,
        pendingContacts: [],
      },
    },
    [
      'pm.test("Photo removed", function () { pm.expect(body.photoUrl).to.eql(undefined); });',
    ],
  ),
  ...[1, 2, 3].map((n) =>
    item(
      `G${21 + n} NFR-035 — data export ${n}/3`,
      "GET",
      "/api/me/export",
      null,
      {
        status: 200,
        body: {
          exportedAt: "<UTC ISO date>",
          profile: {},
          tickets: [],
          hikingHistory: [],
          payments: [],
          refundRequests: [],
          checkIns: [],
          notificationPreferences: {},
        },
      },
      [
        'pm.test("Download excludes credentials/signing data", function () { pm.expect(pm.response.headers.get("Content-Disposition")).to.include("attachment"); for (const key of ["passwordHash","sessionVersion","qrToken","tokenHash","photoPublicId","ownerHash","accessCode","deliveryPayload","_id"]) pm.expect(pm.response.text()).not.to.include(JSON.stringify(key)); });',
      ],
    ),
  ),
  item(
    "G25 NFR-035 — fourth export is limited",
    "GET",
    "/api/me/export",
    null,
    fail(
      429,
      "rate_limited",
      "You can download your data three times per hour. Please try again later.",
      { retryAfterSeconds: 3600 },
    ),
  ),
  item(
    "G26 AUTH-018 — upcoming tickets block deletion",
    "DELETE",
    "/api/me",
    { password: "{{accountPassword}}", confirm: "DELETE" },
    fail(
      409,
      "ACCOUNT_HAS_UPCOMING_TICKETS",
      "You have upcoming tickets. Request refunds or wait until those events have passed before deleting your account.",
    ),
  ),
  item(
    "G27 AUTH-018 — log in as a disposable hiker without upcoming tickets",
    "POST",
    "/api/auth/user-login",
    {
      identifier: "{{accountDeleteEmail}}",
      password: "{{accountDeletePassword}}",
      remember: false,
    },
    {
      status: 200,
      body: { id: "<user ID>", roles: ["hiker"], fullName: "Disposable hiker" },
    },
    loginChecks("accountDeleteCookie"),
    { cookieVar: undefined },
  ),
  item(
    "G28 AUTH-018 — exact confirmation required",
    "DELETE",
    "/api/me",
    { password: "{{accountDeletePassword}}", confirm: "delete" },
    fail(400, "validation_error", "Type DELETE to confirm account deletion", {
      field: "confirm",
    }),
    [],
    { cookieVar: "accountDeleteCookie" },
  ),
  item(
    "G29 AUTH-018 — anonymise and end sessions",
    "DELETE",
    "/api/me",
    { password: "{{accountDeletePassword}}", confirm: "DELETE" },
    { status: 204 },
    [],
    { cookieVar: "accountDeleteCookie" },
  ),
  item(
    "G30 AUTH-012 — deleted session no longer works",
    "GET",
    "/api/me/tickets",
    null,
    fail(401, "unauthenticated", "Please log in to continue."),
    [],
    { cookieVar: "accountDeleteCookie" },
  ),
  item(
    "G31 AUTH-012 — signed-out request refused",
    "GET",
    "/api/me/tickets",
    null,
    fail(401, "unauthenticated", "Please log in to continue."),
    [],
    { cookieVar: undefined },
  ),
];
