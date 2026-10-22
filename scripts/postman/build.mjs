import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cases, variables } from "./auth.mjs";
import {
  cases as accountCases,
  variables as accountVariables,
} from "./account.mjs";
import {
  cases as profileCases,
  variables as profileVariables,
} from "./profile.mjs";
import {
  cases as staffCases,
  variables as staffVariables,
} from "./admin-auth.mjs";
import {
  cases as managementCases,
  variables as managementVariables,
} from "./staff.mjs";
import {
  cases as eventCases,
  variables as eventVariables,
  initialize as eventInitialize,
} from "./events.mjs";
import {
  cases as checkoutCases,
  variables as checkoutVariables,
  initialize as checkoutInitialize,
} from "./checkout.mjs";
import {
  cases as overviewCases,
  auditCases,
  variables as overviewVariables,
} from "./overview.mjs";

import {
  cases as transactionsCases,
  variables as transactionVariables,
} from "./transactions.mjs";

const getPath = (path) =>
  `body${path
    .split(".")
    .map((part) => `[${JSON.stringify(part)}]`)
    .join("")}`;
function testsFor(test) {
  const lines = [
    `pm.test("HTTP ${test.expected.status}", function () { pm.expect(pm.response.code).to.eql(${test.expected.status}); });`,
  ];
  if (test.expected.status === 204) {
    lines.push(
      'pm.test("Empty response", function () { pm.expect(pm.response.text()).to.eql(""); });',
    );
    return lines;
  }
  lines.push("const body = pm.response.json();");
  if (test.captureCheckoutCookie) {
    const variable =
      typeof test.captureCheckoutCookie === "string"
        ? test.captureCheckoutCookie
        : "checkoutCookie";
    lines.push(
      'const checkoutHeader = pm.response.headers.all().find(h => h.key.toLowerCase() === "set-cookie" && h.value.startsWith("hip_checkout="));',
      `if (checkoutHeader) { pm.environment.set(${JSON.stringify(variable)}, checkoutHeader.value.split(";")[0]); pm.test("HttpOnly checkout cookie", function () { pm.expect(checkoutHeader.value.includes("HttpOnly")).to.eql(true); }); }`,
      `pm.test("Checkout browser has a cookie", function () { pm.expect(Boolean(pm.variables.get(${JSON.stringify(variable)}))).to.eql(true); });`,
    );
  }
  if (test.captureCookieAs) {
    lines.push(
      'const sessionHeader = pm.response.headers.all().find(h => h.key.toLowerCase() === "set-cookie" && h.value.startsWith("hip_staff_session="));',
      'pm.test("HttpOnly staff session", function () { pm.expect(Boolean(sessionHeader && sessionHeader.value.includes("HttpOnly"))).to.eql(true); });',
      `pm.environment.set(${JSON.stringify(test.captureCookieAs)}, sessionHeader.value.split(";")[0]);`,
    );
  }
  for (const [key, path] of Object.entries(test.capture ?? {})) {
    lines.push(`pm.environment.set(${JSON.stringify(key)}, ${getPath(path)});`);
    if (
      key.endsWith("CreatedAt") ||
      key.endsWith("LastActiveAt") ||
      key.endsWith("TwoFactorAt")
    )
      lines.push(
        `pm.test(${JSON.stringify(`${key} is a UTC date`)}, function () { pm.expect(typeof ${getPath(path)} === "string" && !Number.isNaN(Date.parse(${getPath(path)}))).to.eql(true); });`,
      );
  }
  if (test.visualizePayment)
    lines.push(
      `pm.visualizer.set(${JSON.stringify('<h3>Paystack test payment</h3><p>First send the pending-status request. Then open this payment link in your browser and pay before the hold expires.</p><a href="https://checkout.paystack.com/{{accessCode}}" target="_blank" rel="noreferrer">Open Paystack test checkout</a><p>Test card: 4084 0840 8408 4081, CVV 408, any future expiry (for example 12/30). After payment send the verified-status request. Never put a secret key in Postman.</p>')}, { accessCode: body.paystackAccessCode });`,
    );
  if (test.accountAssertions) return [...lines, ...test.accountAssertions];
  if (test.checkoutAssertions) return [...lines, ...test.checkoutAssertions];
  if (test.eventAssertions) return [...lines, ...test.eventAssertions];
  if (test.overviewAssertions) return [...lines, ...test.overviewAssertions];
  if (test.captureEmailDestination) {
    const prefix = test.captureEmailDestination;
    lines.push(
      `pm.environment.set("${prefix}Destination", pm.variables.get("${prefix}Email").replace(/^(.)[^@]*(@.*)$/, "$1•••••$2"));`,
    );
  }
  if (test.setupPrefix) {
    lines.push(
      'pm.test("Authenticator setup", function () { pm.expect(/^data:image\\/png;base64,/.test(body.qrCode)).to.eql(true); pm.expect(/^[A-Z2-7]+$/.test(body.setupKey)).to.eql(true); });',
      `pm.visualizer.set(${JSON.stringify('<h3>Scan in Google Authenticator or a similar app</h3><img src="{{qrCode}}" alt="Authenticator setup QR" /><p>Enter the app’s current code in the private authenticator code variable before enabling.</p>')}, { qrCode: body.qrCode });`,
    );
  }
  if (test.staffList) {
    lines.push(
      'for (const m of body) { if (m.isYou) pm.environment.set("staffLastActiveAt", m.lastActiveAt); for (const prefix of ["inviteAdmin", "inviteCheckin"]) { if (m.id === pm.variables.get(prefix + "UserId")) { pm.environment.set(prefix + "LastActiveAt", m.lastActiveAt); pm.environment.set(prefix + "TwoFactorAt", m.twoFactor.setUpAt); } } }',
      'pm.test("Only public staff fields", function () { pm.expect(Array.isArray(body)).to.eql(true); body.forEach(m => { pm.expect(Object.keys(m).filter(k => k !== "lastActiveAt").sort()).to.deep.eql(["email", "id", "isYou", "name", "role", "status", "twoFactor"]); pm.expect(["super_admin", "admin", "checkin_staff", "advertiser"].includes(m.role)).to.eql(true); pm.expect(["active", "deactivated", "invited"].includes(m.status)).to.eql(true); }); });',
      'pm.test("Current staff member", function () { const me = body.filter(m => m.isYou); pm.expect(me.length).to.eql(1); pm.expect(me[0].id).to.eql(pm.variables.get("staffUserId")); pm.expect(me[0].email).to.eql(pm.variables.get("staffEmail")); });',
    );
    if (test.finalStaffList)
      lines.push(
        'pm.test("Accepted members and cancelled invites", function () { for (const prefix of ["inviteAdmin", "inviteCheckin"]) { const member = body.find(m => m.id === pm.variables.get(prefix + "UserId")); pm.expect(Boolean(member && member.twoFactor.setUp && member.status === "active")).to.eql(true); pm.expect(body.some(m => m.id === pm.variables.get(prefix + "Id"))).to.eql(false); } pm.expect(body.some(m => m.id === pm.variables.get("expiredInviteId"))).to.eql(false); });',
      );
    return lines;
  }
  if (test.captureStaffChallenge)
    lines.push(
      'pm.collectionVariables.set("staffChallengeId", body.challengeId);',
      'pm.collectionVariables.set("staffDestination", pm.collectionVariables.get("staffEmail").replace(/^(.)[^@]*(@.*)$/, "$1•••••$2"));',
      'pm.collectionVariables.set("staffResendAt", new Date(Date.now() + 60000).toISOString());',
    );
  if (test.captureStaffUser)
    lines.push(
      'pm.collectionVariables.set("staffUserId", body.id); pm.collectionVariables.set("staffCreatedAt", body.createdAt);',
    );
  if (test.captureStaffSetup)
    lines.push(
      'pm.test("Private setup response", function () { pm.expect(/^data:image\\/png;base64,/.test(body.qrCode)).to.eql(true); pm.expect(/^[A-Z2-7]+$/.test(body.setupKey)).to.eql(true); });',
      'pm.collectionVariables.set("staffQrCode", body.qrCode); pm.collectionVariables.set("staffSetupKey", body.setupKey);',
      `pm.visualizer.set(${JSON.stringify('<h3>Scan with Google Authenticator or a similar app</h3><img src="{{qrCode}}" alt="HIP authenticator setup QR" /><p>Save the app’s current six-digit code as staffAuthenticatorCode, then send C10.</p>')}, { qrCode: body.qrCode });`,
    );
  if (test.rotate)
    lines.push(
      'pm.collectionVariables.set("oldVerificationId", pm.collectionVariables.get("verificationId"));',
    );
  if (test.captureVerification)
    lines.push(
      'for (const key of ["verificationId", "resendAvailableAt"]) pm.collectionVariables.set(key, body[key]);',
    );
  if (test.captureVerificationAs) {
    const prefix = test.captureVerificationAs;
    lines.push(
      `pm.collectionVariables.set("${prefix}VerificationId", body.verificationId); pm.collectionVariables.set("${prefix}ResendAvailableAt", body.resendAvailableAt);`,
    );
  }
  if (test.captureUserAs) {
    const prefix = test.captureUserAs;
    lines.push(
      `pm.collectionVariables.set("${prefix}UserId", body.user.id); pm.collectionVariables.set("${prefix}CreatedAt", body.user.createdAt);`,
    );
  }
  if (test.captureContact) {
    const field = test.captureContact;
    lines.push(
      `const pending = body.pendingContacts.find(c => c.field === "${field}"); pm.collectionVariables.set("${field}ChangeId", pending.verificationId); pm.collectionVariables.set("${field}ResendAt", pending.resendAvailableAt);`,
    );
  }
  if (test.captureUser)
    lines.push(
      'pm.collectionVariables.set("userId", body.user.id); pm.collectionVariables.set("createdAt", body.user.createdAt);',
    );
  if (test.dynamicCooldown) {
    lines.push(
      'pm.test("Resend cooldown", function () { pm.expect(body.code).to.eql("rate_limited"); pm.expect(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 60).to.eql(true); pm.expect(body.success).to.eql(false); pm.expect(body.status).to.eql(429); });',
    );
  } else {
    lines.push(
      `const expected = JSON.parse(pm.variables.replaceIn(${JSON.stringify(JSON.stringify(test.expected.body))}));`,
    );
    lines.push(
      'pm.test("Exact response shape", function () { pm.expect(body).to.deep.eql(expected); });',
    );
  }
  for (const field of test.captureUser ? ["user.id", "user.createdAt"] : []) {
    lines.push(
      `pm.test(${JSON.stringify(field)}, function () { pm.expect(typeof ${getPath(field)}).to.eql("string"); });`,
    );
  }
  return lines;
}

function buildItem(test) {
  const request = {
    method: test.method,
    header: [
      ...(test.multipart
        ? []
        : [{ key: "Content-Type", value: "application/json" }]),
      ...(test.cookieVar
        ? [{ key: "Cookie", value: `{{${test.cookieVar}}}` }]
        : []),
      ...(test.badWebhook
        ? [{ key: "x-paystack-signature", value: "0".repeat(128) }]
        : []),
    ],
    url: `{{baseUrl}}${test.path}`,
    ...(test.multipart
      ? {
          body: {
            mode: "formdata",
            formdata: [
              { key: "image", type: "file", src: `{{${test.multipart}}}` },
            ],
          },
        }
      : {}),
    ...(test.body
      ? {
          body: {
            mode: "raw",
            raw: JSON.stringify(test.body, null, 2),
            options: { raw: { language: "json" } },
          },
        }
      : {}),
    description: test.accountController
      ? "Controller 7. Requires a private hiker cookie. Prepare paid future/past, free, checked-in and foreign tickets in a dedicated test database. Refund requests do not call Paystack or release capacity. Export at most three times per hour. Deletion anonymises a disposable hiker only; capture the old recipient before clearing it and send confirmation from the transactional encrypted outbox after commit. Never export populated cookies/passwords."
      : test.transactionsController
        ? "PAY-*, ANA-028, TKT-020. Read-only payments from stored orders, one row per order. Full super-admin/admin session required. Dates are inclusive Lagos calendar dates; CSV uses all=true. Refund writes are not built. Test net revenue is virtual and never bank settlement. Keep cookies private."
        : test.auditController
          ? "ADM-014, NFR-012. Super-admin-only read access to the same immutable entries as Overview. Filters: q, action or group, actorId, inclusive Africa/Lagos from/to dates, page; all=true for the existing CSV export. Reuses private Overview test cookies. There is no edit/delete endpoint. No populated cookies or secrets belong in exports."
          : test.overviewController
            ? "ANA-001–ANA-004. Read-only real Overview. Use private full-session managerCookie and overviewAdminCookie; other cookies exercise permission/setup errors. Never export populated cookies. Registered hikers exclude unfinished signups and guests; sales use verified paid orders and issued tickets, grouped by payment time in Africa/Lagos weeks. Net excludes the buyer-paid processing fee. No check-in/refund ledger exists yet, so attendance and pending refunds remain zero. Examples are illustrative; assertions accept the database's current totals."
            : test.checkoutController
              ? "TKT-006–TKT-018. Prepare Controller 5 published fixtures: free Community ticket (0 kobo), capacity/limit 1; paid Standard ticket (250000 kobo), capacity/limit 2. Use a disposable inbox, a valid phone and a different emergency phone. Configure the illustrative 5% fee and group settlement before the paid cases; run the displayed setup requests after F10. Use checkoutManagerCookie/checkoutAdminCookie from staff login, and private settlementBankCode/settlementAccountNumber/settlementAccountName. Paystack must be in test mode. The new /api/admin/checkout/settings endpoints are super-admin only. Cookies, bank details, guest tokens and access codes belong in a private environment. No Paystack secret key is ever used by Postman. F07 needs the recovery-email token. Complete the hosted payment with the official Paystack test card before F14; F22 needs the pending hold to expire after ten minutes. The isolated verifier advances only its private test fixtures. No refunds/history/check-in endpoints are built here."
              : test.eventsController
                ? "EVT-001–EVT-012, WEB-006/011, SRCH-007. Use an enrolled super admin and private environment for staffEmail/staffPassword/staffAuthenticatorCode and managerCookie. Fill eventNonAdminCookie with a full check-in staff or advertiser cookie. Select a JPG/PNG/WebP <=5 MB for coverFile, a text file for coverWrongFile, and an image >5 MB for coverLargeFile. Dates use Africa/Lagos; responses are UTC. Ticket holds and checkout are in Controller 6; refunds and ticket-holder notifications remain unbuilt. No user data is created by public reads. Never export populated credentials/cookies."
                : test.staffManagement
                  ? "ADM-001–ADM-008. Use a dedicated replica-set database and disposable inboxes. An enrolled super admin is required. Select a private Postman environment: scripts keep separate manager/admin/check-in cookies there, and each request disables the shared cookie jar. Fill invite tokens from email before acceptance; resending invalidates the previous link. Scan each setup QR in Visualize and enter a fresh app code. The expired-invite case requires an already expired disposable link (the local verifier prepares it without a public expiry endpoint). Never export populated passwords, cookies, tokens or setup keys."
                  : test.name.startsWith("C")
                    ? "ADM-001. Start with a new, un-enrolled super admin from SUPER_ADMIN_* in a dedicated development server. Fill staffEmail/staffName/staffPassword privately. C08 Visualize displays the QR; scan it or enter setupKey in a time-based authenticator. Enter a fresh app code in staffAuthenticatorCode for C10/C19/C20. C22 needs the active hiker from Controller 2; C24 needs a deactivated staff fixture in the test database (staff creation comes in Controller 4). This folder enrolls the admin and ends with a 15-minute lock; do not rerun against an already enrolled real account. Never export populated secrets or codes."
                    : test.captureReset
                      ? "Copy the token from the reset email into resetToken before sending request 30. Do not share an exported environment containing credentials or tokens."
                      : "Users auth/profile. Use disposable accounts and the cookie jar. For automated runs only, set DEV_FIXED_CODE=123456 in a dedicated development server; regular development uses random email codes.",
  };
  const events = [
    {
      listen: "test",
      script: { type: "text/javascript", exec: testsFor(test) },
    },
  ];
  if (test.eventsController)
    events.unshift({
      listen: "prerequest",
      script: { type: "text/javascript", exec: eventInitialize },
    });
  if (test.checkoutController)
    events.unshift({
      listen: "prerequest",
      script: { type: "text/javascript", exec: checkoutInitialize },
    });
  if (test.rememberOldToken)
    events.unshift({
      listen: "prerequest",
      script: {
        type: "text/javascript",
        exec: [
          'pm.environment.set("oldInviteAdminToken", pm.variables.get("inviteAdminToken"));',
        ],
      },
    });
  if (
    test.waitForResend ||
    test.waitForContactResend ||
    test.waitForStaffResend
  )
    events.unshift({
      listen: "prerequest",
      script: {
        type: "text/javascript",
        exec: [
          `const wait = Math.max(0, new Date(pm.collectionVariables.get("${test.waitForStaffResend ? "staffResendAt" : test.waitForContactResend ? "emailResendAt" : "resendAvailableAt"}")).getTime() - Date.now());`,
          "setTimeout(function () {}, wait + 100);",
        ],
      },
    });
  return {
    name: test.name,
    ...(test.staffManagement ||
    test.eventsController ||
    test.checkoutController ||
    test.overviewController ||
    test.accountController
      ? { protocolProfileBehavior: { disableCookies: true } }
      : {}),
    request,
    event: events,
    response: [
      {
        name: `Expected ${test.expected.status}`,
        originalRequest: request,
        status: String(test.expected.status),
        code: test.expected.status,
        header:
          test.expected.status === 204
            ? []
            : [{ key: "Content-Type", value: "application/json" }],
        body:
          test.expected.status === 204
            ? ""
            : JSON.stringify(test.expected.body, null, 2),
      },
    ],
  };
}

const items = cases.map(buildItem);
const profileItems = profileCases.map(buildItem);

const initialize = [
  'const unique = pm.variables.replaceIn("{{$randomUUID}}");',
  'const defaults = { email: "ada-" + unique + "@example.com", otherEmail: "unknown-" + unique + "@example.com", phone: "+234803" + String(Date.now() % 10000000).padStart(7, "0"), otherPhone: "+234804" + String(Date.now() % 10000000).padStart(7, "0"), password: unique + "1!", wrongPassword: unique + "2!", newPassword: unique + "3!" };',
  'Object.assign(defaults, { profileEmail: "profile-" + unique + "@example.com", otherProfileEmail: "other-profile-" + unique + "@example.com", newProfileEmail: "new-profile-" + unique + "@example.com", cancelProfileEmail: "cancel-profile-" + unique + "@example.com", profilePhone: "+234805" + String(Date.now() % 10000000).padStart(7, "0"), otherProfilePhone: "+234806" + String(Date.now() % 10000000).padStart(7, "0"), newProfilePhone: "+234807" + String(Date.now() % 10000000).padStart(7, "0"), profilePassword: unique + "4!" });',
  "for (const key of Object.keys(defaults)) if (!pm.collectionVariables.get(key)) pm.collectionVariables.set(key, defaults[key]);",
];
const collection = {
  info: {
    name: "HIP — Users, staff, events and checkout",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description:
      "Controllers 1–6: AUTH-001–AUTH-017, NOT-010, ADM-001–ADM-008, EVT-001–EVT-012 and TKT-006–TKT-018. Run each folder in order with disposable accounts. Staff, events and checkout require a MongoDB replica set. Use a private environment for cookies and email links. Paystack/Cloudinary secrets stay server-side. Automated auth tests use DEV_FIXED_CODE=123456; normal development sends random codes. It never replaces authenticator codes. Exported defaults contain no credentials.",
  },
  variable: Object.entries({
    ...variables,
    ...profileVariables,
    ...staffVariables,
    ...managementVariables,
    ...eventVariables,
    ...checkoutVariables,
    ...overviewVariables,
    ...transactionVariables,
    ...accountVariables,
  }).map(([key, value]) => ({
    key,
    value,
    type: "string",
  })),
  event: [
    {
      listen: "prerequest",
      script: { type: "text/javascript", exec: initialize },
    },
  ],
  item: [
    { name: "Controller 1 — Users auth", item: items },
    { name: "Controller 2 — Users profile", item: profileItems },
    { name: "Controller 3 — Admin auth", item: staffCases.map(buildItem) },
    {
      name: "Controller 4 — Staff & roles",
      item: managementCases.map(buildItem),
    },
    { name: "Controller 5 — Events", item: eventCases.map(buildItem) },
    {
      name: "Controller 6 — Checkout & tickets",
      item: checkoutCases.map(buildItem),
    },
    { name: "Controller 7 — Hiker account", item: accountCases.map(buildItem) },
    { name: "Admin — Overview", item: overviewCases.map(buildItem) },
    { name: "Admin — Audit log", item: auditCases.map(buildItem) },
    { name: "Admin — Transactions", item: transactionsCases.map(buildItem) },
  ],
};
await mkdir(new URL("../../postman/", import.meta.url), { recursive: true });
await writeFile(
  new URL(
    "../../postman/HIP-users-auth.postman_collection.json",
    import.meta.url,
  ),
  `${JSON.stringify(collection, null, 2)}\n`,
);
const docsUrl = new URL("../../docs/API.md", import.meta.url);
const docs = await readFile(docsUrl, "utf8");
const startMarker = "<!-- Controller 5 ordered cases: start -->";
const endMarker = "<!-- Controller 5 ordered cases: end -->";
const cell = (value) => String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
const rows = eventCases.map((test) => {
  const body = test.multipart
    ? `Multipart image file: {{${test.multipart}}}`
    : test.body
      ? JSON.stringify(test.body)
      : "None";
  let expected = "No body";
  if (test.expected.body) {
    if (test.expected.status >= 400)
      expected = JSON.stringify(test.expected.body);
    else if (test.multipart) expected = "{ url: HTTPS Cloudinary URL }";
    else if (test.expected.body.event)
      expected = `{ event (${test.expected.body.event.status}), ticketTypes }`;
    else if (test.expected.body.challengeId)
      expected = "StaffChallenge (authenticator)";
    else if (test.path.endsWith("/verify"))
      expected = "Staff User + HttpOnly staff cookie";
    else if (Array.isArray(test.expected.body))
      expected = test.path.includes("ticket-types")
        ? "TicketType[]"
        : "HikeEvent[]";
    else if (test.expected.body.items)
      expected = test.path.startsWith("/api/admin")
        ? "AdminEventsPage"
        : "Paginated<HikeEvent>";
    else expected = `HikeEvent (${test.expected.body.status})`;
  }
  return `| ${cell(test.name)} | ${test.method} \`${cell(test.path)}\` | ${cell(body)} | ${test.expected.status}: ${cell(expected)} |`;
});
if (!docs.includes(startMarker) || !docs.includes(endMarker))
  throw new Error("Controller 5 documentation markers are missing.");
await writeFile(
  docsUrl,
  docs.slice(0, docs.indexOf(startMarker)) +
    startMarker +
    "\n\n| Test | Method / URL | Request | Expected |\n| --- | --- | --- | --- |\n" +
    rows.join("\n") +
    "\n\n" +
    docs.slice(docs.indexOf(endMarker)),
);
console.log(
  `Generated ${cases.length} auth, ${profileCases.length} profile, ${staffCases.length} admin-auth, ${managementCases.length} staff, ${eventCases.length} events and ${checkoutCases.length} checkout, ${overviewCases.length} Overview and ${auditCases.length} audit and ${transactionsCases.length} transaction requests with examples and assertions.`,
);

// Keep Controller 6's ordered test table generated from the same source as the collection.
const checkoutDocs = await readFile(docsUrl, "utf8");
const checkoutStart = "<!-- Controller 6 ordered cases: start -->";
const checkoutEnd = "<!-- Controller 6 ordered cases: end -->";
if (
  !checkoutDocs.includes(checkoutStart) ||
  !checkoutDocs.includes(checkoutEnd)
)
  throw new Error("Controller 6 documentation markers are missing.");
const checkoutRows = checkoutCases.map(
  (test) =>
    `| ${cell(test.name)} | ${test.method} \`${cell(test.path)}\` | ${cell(test.body ? JSON.stringify(test.body) : "None")} | ${test.expected.status}: ${cell(test.expected.status === 204 ? "No body" : test.expected.status >= 400 ? JSON.stringify(test.expected.body) : test.path.includes("/admin/checkout/") ? "CheckoutSettings" : test.path.endsWith("/quote") ? "CheckoutQuote" : test.path.includes("/holds") ? "SeatHold" : test.path.includes("guestTicketToken") || test.path.startsWith("/api/tickets/") ? "TicketDetails" : test.method === "POST" ? "CheckoutResponse" : "CheckoutStatus")} |`,
);
await writeFile(
  docsUrl,
  checkoutDocs.slice(0, checkoutDocs.indexOf(checkoutStart)) +
    checkoutStart +
    "\n\n| Test | Method / URL | Request | Expected |\n| --- | --- | --- | --- |\n" +
    checkoutRows.join("\n") +
    "\n\n" +
    checkoutDocs.slice(checkoutDocs.indexOf(checkoutEnd)),
);

const accountDocs = await readFile(docsUrl, "utf8");
const accountStart = "<!-- Controller 7 ordered cases: start -->";
const accountEnd = "<!-- Controller 7 ordered cases: end -->";
if (!accountDocs.includes(accountStart) || !accountDocs.includes(accountEnd))
  throw new Error("Controller 7 documentation markers are missing.");
const accountRows = accountCases.map(
  (test) =>
    `| ${cell(test.name)} | ${test.method} \`${cell(test.path)}\` | ${cell(test.multipart ? `Multipart image: {{${test.multipart}}}` : test.body ? JSON.stringify(test.body) : "None")} | ${test.expected.status}: ${cell(test.expected.status >= 400 ? JSON.stringify(test.expected.body) : test.expected.status === 204 ? "No body" : JSON.stringify(test.expected.body))} |`,
);
await writeFile(
  docsUrl,
  accountDocs.slice(0, accountDocs.indexOf(accountStart)) +
    accountStart +
    "\n\n| Test | Method / URL | Request | Expected example |\n| --- | --- | --- | --- |\n" +
    accountRows.join("\n") +
    "\n\n" +
    accountDocs.slice(accountDocs.indexOf(accountEnd)),
);
console.log(
  `Generated ${accountCases.length} Controller 7 account checks with blank private variables.`,
);
