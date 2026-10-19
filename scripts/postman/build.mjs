import { mkdir, writeFile } from "node:fs/promises";
import { cases, variables } from "./auth.mjs";
import {
  cases as profileCases,
  variables as profileVariables,
} from "./profile.mjs";
import {
  cases as staffCases,
  variables as staffVariables,
} from "./admin-auth.mjs";

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
    header: [{ key: "Content-Type", value: "application/json" }],
    url: `{{baseUrl}}${test.path}`,
    ...(test.body
      ? {
          body: {
            mode: "raw",
            raw: JSON.stringify(test.body, null, 2),
            options: { raw: { language: "json" } },
          },
        }
      : {}),
    description: test.name.startsWith("C")
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
    name: "HIP — Users auth, profile and admin auth",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description:
      "Controllers 1–3: AUTH-001–AUTH-017, NOT-010 and ADM-001. Each folder runs in order using disposable accounts and cookies. Automated runs require DEV_FIXED_CODE=123456 on a dedicated development server; regular development uses random email codes. Auth 11, profile P24 and admin C05 wait for real resend cooldowns. Pause auth after request 29 for the reset-email token. Admin auth requires the private seeded credentials, an authenticator app and a deactivated fixture; C08 Visualize shows the setup QR. DEV_FIXED_CODE never replaces authenticator codes. Exported defaults contain no credentials.",
  },
  variable: Object.entries({
    ...variables,
    ...profileVariables,
    ...staffVariables,
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
console.log(
  `Generated ${cases.length} auth, ${profileCases.length} profile and ${staffCases.length} admin-auth requests with examples and assertions.`,
);
