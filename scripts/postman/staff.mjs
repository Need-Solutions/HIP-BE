// ADM-001–ADM-008. Synthetic bodies only; secrets are filled privately at run time.
const error = (status, code, message, details = {}) => ({
  status,
  body: { message, success: false, status, code, ...details },
});
const forbidden = error(
  403,
  "forbidden",
  "Only a super admin can manage staff.",
);
const setupOnly = error(
  403,
  "two_step_required",
  "Set up your authenticator to finish signing in.",
);
const unauthenticated = error(
  401,
  "unauthenticated",
  "Please sign in as staff to continue.",
);
const invalidInvite = error(
  410,
  "invite_expired",
  "This invite is invalid or has expired. Ask a super admin for a new invite.",
);
const member = (prefix, role, status = "invited", enabled = false) => ({
  id: `{{${prefix}Id}}`,
  name: `{{${prefix}Name}}`,
  email: `{{${prefix}Email}}`,
  role,
  status,
  ...(status === "invited"
    ? {}
    : enabled || status === "active"
      ? { lastActiveAt: `{{${prefix}LastActiveAt}}` }
      : {}),
  twoFactor: {
    setUp: enabled,
    ...(enabled ? { setUpAt: `{{${prefix}TwoFactorAt}}` } : {}),
  },
  isYou: false,
});
const user = (prefix, role) => ({
  id: `{{${prefix}UserId}}`,
  fullName: `{{${prefix}Name}}`,
  email: `{{${prefix}Email}}`,
  phone: "",
  roles: [role],
  status: "active",
  emailVerified: true,
  phoneVerified: false,
  createdAt: `{{${prefix}CreatedAt}}`,
});
const owner = () => ({ ...user("staff", "super_admin") });
const managerExample = {
  id: "{{staffUserId}}",
  name: "{{staffName}}",
  email: "{{staffEmail}}",
  role: "super_admin",
  status: "active",
  lastActiveAt: "{{staffLastActiveAt}}",
  twoFactor: { setUp: true },
  isYou: true,
};
let sequence = 0;
const item = (label, method, path, body, expected, extra = {}) => ({
  name: `D${String(++sequence).padStart(2, "0")} ADM-001–ADM-008 — ${label}`,
  method,
  path,
  ...(body === undefined ? {} : { body }),
  expected,
  staffManagement: true,
  cookieVar: "managerCookie",
  ...extra,
});
const auth = (label, path, body, expected, extra = {}) =>
  item(label, "POST", `/api/auth/staff/${path}`, body, expected, {
    cookieVar: undefined,
    ...extra,
  });
const action = (label, path, expected, extra = {}) =>
  item(label, "POST", `/api/admin/staff/${path}`, {}, expected, extra);
const role = (label, id, value, expected, extra = {}) =>
  item(
    label,
    "PUT",
    `/api/admin/staff/${id}/role`,
    { role: value },
    expected,
    extra,
  );
const accept = (label, prefix, expected, extra = {}) =>
  auth(
    label,
    "invites/accept",
    { token: `{{${prefix}Token}}`, password: `{{${prefix}Password}}` },
    expected,
    extra,
  );
const invite = (label, prefix, value) =>
  item(
    label,
    "POST",
    "/api/admin/staff/invites",
    { name: `{{${prefix}Name}}`, email: `{{${prefix}Email}}`, role: value },
    { status: 200, body: member(prefix, value) },
    {
      capture: { [`${prefix}Id`]: "id" },
      captureInviteTokenAs: `${prefix}Token`,
    },
  );
const memberCapture = (prefix) => ({
  [`${prefix}LastActiveAt`]: "lastActiveAt",
  [`${prefix}TwoFactorAt`]: "twoFactor.setUpAt",
});
const acceptedCapture = (prefix) => ({
  [`${prefix}UserId`]: "id",
  [`${prefix}CreatedAt`]: "createdAt",
});
const setup = (prefix, label) =>
  auth(
    label,
    "two-step/setup",
    {},
    {
      status: 200,
      body: {
        qrCode: `{{${prefix}QrCode}}`,
        setupKey: `{{${prefix}SetupKey}}`,
      },
    },
    {
      cookieVar: `${prefix}Cookie`,
      setupPrefix: prefix,
      capture: {
        [`${prefix}QrCode`]: "qrCode",
        [`${prefix}SetupKey`]: "setupKey",
      },
    },
  );
const enable = (prefix, value) =>
  auth(
    `enable ${prefix} authenticator`,
    "two-step/enable",
    { code: `{{${prefix}AuthenticatorCode}}` },
    { status: 200, body: user(prefix, value) },
    {
      cookieVar: `${prefix}Cookie`,
      captureCookieAs: `${prefix}Cookie`,
      prepareTotpFor: prefix,
    },
  );

export const cases = [
  auth(
    "super admin password step (already enrolled)",
    "login",
    { email: "{{staffEmail}}", password: "{{staffPassword}}" },
    {
      status: 200,
      body: { challengeId: "{{staffChallengeId}}", method: "authenticator" },
    },
    { capture: { staffChallengeId: "challengeId" } },
  ),
  auth(
    "super admin authenticator step",
    "verify",
    { challengeId: "{{staffChallengeId}}", code: "{{staffAuthenticatorCode}}" },
    { status: 200, body: owner() },
    {
      prepareTotp: true,
      captureCookieAs: "managerCookie",
      capture: { staffUserId: "id", staffCreatedAt: "createdAt" },
    },
  ),
  item(
    "list staff",
    "GET",
    "/api/admin/staff",
    undefined,
    { status: 200, body: [managerExample] },
    { staffList: true },
  ),
  invite("invite an admin", "inviteAdmin", "admin"),
  invite("invite check-in staff", "inviteCheckin", "checkin_staff"),
  item(
    "duplicate pending email stays under email",
    "POST",
    "/api/admin/staff/invites",
    {
      name: "{{inviteAdminName}}",
      email: "{{inviteAdminEmail}}",
      role: "admin",
    },
    error(
      409,
      "email_taken",
      "This email already belongs to a staff member or invite.",
      { field: "email" },
    ),
  ),
  action(
    "resend admin invite and rotate its link",
    "invites/{{inviteAdminId}}/resend",
    { status: 204 },
    { captureInviteTokenAs: "inviteAdminToken", rememberOldToken: true },
  ),
  auth(
    "old resend link cannot be accepted",
    "invites/accept",
    { token: "{{oldInviteAdminToken}}", password: "{{inviteAdminPassword}}" },
    invalidInvite,
  ),
  action("cancel check-in invitation", "{{inviteCheckinId}}/deactivate", {
    status: 200,
    body: member("inviteCheckin", "checkin_staff", "deactivated"),
  }),
  accept("cancelled link cannot be accepted", "inviteCheckin", invalidInvite),
  invite("invite check-in staff again", "inviteCheckin", "checkin_staff"),
  accept(
    "admin accepts the latest link",
    "inviteAdmin",
    { status: 200, body: user("inviteAdmin", "admin") },
    {
      captureCookieAs: "inviteAdminCookie",
      capture: acceptedCapture("inviteAdmin"),
    },
  ),
  accept("used invite cannot be accepted twice", "inviteAdmin", invalidInvite),
  item(
    "accepted admin has setup-only session",
    "GET",
    "/api/auth/staff/me",
    undefined,
    setupOnly,
    { cookieVar: "inviteAdminCookie" },
  ),
  item(
    "setup-only session cannot list staff",
    "GET",
    "/api/admin/staff",
    undefined,
    setupOnly,
    { cookieVar: "inviteAdminCookie" },
  ),
  setup("inviteAdmin", "admin scans authenticator QR"),
  enable("inviteAdmin", "admin"),
  item(
    "admin full session",
    "GET",
    "/api/auth/staff/me",
    undefined,
    { status: 200, body: user("inviteAdmin", "admin") },
    { cookieVar: "inviteAdminCookie" },
  ),
  ...[
    ["GET", "/api/admin/staff", undefined],
    [
      "POST",
      "/api/admin/staff/invites",
      { name: "Blocked Invite", email: "blocked@example.com", role: "admin" },
    ],
    ["POST", "/api/admin/staff/invites/{{inviteCheckinId}}/resend", {}],
    ["PUT", "/api/admin/staff/{{staffUserId}}/role", { role: "admin" }],
    ["POST", "/api/admin/staff/{{staffUserId}}/deactivate", {}],
    ["POST", "/api/admin/staff/{{staffUserId}}/activate", {}],
    ["POST", "/api/admin/staff/{{staffUserId}}/two-factor/reset", {}],
  ].map(([method, path, body]) =>
    item(`admin cannot ${method} ${path}`, method, path, body, forbidden, {
      cookieVar: "inviteAdminCookie",
    }),
  ),
  role(
    "change admin to check-in staff",
    "{{inviteAdminUserId}}",
    "checkin_staff",
    {
      status: 200,
      body: {
        ...member("inviteAdmin", "checkin_staff", "active", true),
        id: "{{inviteAdminUserId}}",
      },
    },
    { capture: memberCapture("inviteAdmin") },
  ),
  item(
    "existing session immediately sees changed role",
    "GET",
    "/api/auth/staff/me",
    undefined,
    { status: 200, body: user("inviteAdmin", "checkin_staff") },
    { cookieVar: "inviteAdminCookie" },
  ),
  role(
    "restore admin role",
    "{{inviteAdminUserId}}",
    "admin",
    {
      status: 200,
      body: {
        ...member("inviteAdmin", "admin", "active", true),
        id: "{{inviteAdminUserId}}",
      },
    },
    { capture: memberCapture("inviteAdmin") },
  ),
  action(
    "deactivate admin",
    "{{inviteAdminUserId}}/deactivate",
    {
      status: 200,
      body: {
        ...member("inviteAdmin", "admin", "deactivated", true),
        id: "{{inviteAdminUserId}}",
      },
    },
    { capture: memberCapture("inviteAdmin") },
  ),
  item(
    "deactivated copied cookie stops working",
    "GET",
    "/api/auth/staff/me",
    undefined,
    { status: 200, body: null },
    { cookieVar: "inviteAdminCookie" },
  ),
  item(
    "deactivated cookie cannot access protected routes",
    "GET",
    "/api/admin/staff",
    undefined,
    unauthenticated,
    { cookieVar: "inviteAdminCookie" },
  ),
  action(
    "reactivate admin",
    "{{inviteAdminUserId}}/activate",
    {
      status: 200,
      body: {
        ...member("inviteAdmin", "admin", "active", true),
        id: "{{inviteAdminUserId}}",
      },
    },
    { capture: memberCapture("inviteAdmin") },
  ),
  item(
    "reactivation never revives the old cookie",
    "GET",
    "/api/auth/staff/me",
    undefined,
    { status: 200, body: null },
    { cookieVar: "inviteAdminCookie" },
  ),
  auth(
    "reactivated admin signs in again",
    "login",
    { email: "{{inviteAdminEmail}}", password: "{{inviteAdminPassword}}" },
    {
      status: 200,
      body: {
        challengeId: "{{inviteAdminChallengeId}}",
        method: "authenticator",
      },
    },
    { capture: { inviteAdminChallengeId: "challengeId" } },
  ),
  auth(
    "admin uses authenticator",
    "verify",
    {
      challengeId: "{{inviteAdminChallengeId}}",
      code: "{{inviteAdminAuthenticatorCode}}",
    },
    { status: 200, body: user("inviteAdmin", "admin") },
    { prepareTotpFor: "inviteAdmin", captureCookieAs: "inviteAdminCookie" },
  ),
  action(
    "super admin resets two-step",
    "{{inviteAdminUserId}}/two-factor/reset",
    {
      status: 200,
      body: {
        ...member("inviteAdmin", "admin", "active"),
        id: "{{inviteAdminUserId}}",
      },
    },
    { capture: { inviteAdminLastActiveAt: "lastActiveAt" } },
  ),
  item(
    "reset revokes the old session",
    "GET",
    "/api/auth/staff/me",
    undefined,
    { status: 200, body: null },
    { cookieVar: "inviteAdminCookie" },
  ),
  auth(
    "next login requires an email code",
    "login",
    { email: "{{inviteAdminEmail}}", password: "{{inviteAdminPassword}}" },
    {
      status: 200,
      body: {
        challengeId: "{{inviteAdminChallengeId}}",
        method: "email",
        destination: "{{inviteAdminDestination}}",
      },
    },
    {
      capture: { inviteAdminChallengeId: "challengeId" },
      captureEmailDestination: "inviteAdmin",
    },
  ),
  auth(
    "email code grants setup-only access again",
    "verify",
    { challengeId: "{{inviteAdminChallengeId}}", code: "{{code}}" },
    { status: 200, body: user("inviteAdmin", "admin") },
    { captureCookieAs: "inviteAdminCookie" },
  ),
  item(
    "reset account must set up again",
    "GET",
    "/api/auth/staff/me",
    undefined,
    setupOnly,
    { cookieVar: "inviteAdminCookie" },
  ),
  setup("inviteAdmin", "scan the new QR after reset"),
  enable("inviteAdmin", "admin"),
  accept(
    "check-in staff accepts the invite",
    "inviteCheckin",
    { status: 200, body: user("inviteCheckin", "checkin_staff") },
    {
      captureCookieAs: "inviteCheckinCookie",
      capture: acceptedCapture("inviteCheckin"),
    },
  ),
  setup("inviteCheckin", "check-in staff scans authenticator QR"),
  enable("inviteCheckin", "checkin_staff"),
  role(
    "cannot change your own role or demote the sole active super admin",
    "{{staffUserId}}",
    "admin",
    error(
      403,
      "own_role",
      "You can’t change your own role. Ask another super admin.",
    ),
  ),
  action(
    "cannot deactivate yourself or the sole active super admin",
    "{{staffUserId}}/deactivate",
    error(403, "own_deactivation", "You can’t deactivate your own account."),
  ),
  invite(
    "prepare an expiring invite (disposable fixture)",
    "expiredInvite",
    "advertiser",
  ),
  accept("expired invite is rejected", "expiredInvite", invalidInvite, {
    expireInviteBefore: true,
  }),
  action("cancel expired invitation", "{{expiredInviteId}}/deactivate", {
    status: 200,
    body: member("expiredInvite", "advertiser", "deactivated"),
  }),
  item(
    "final list contains real staff and no cancelled invites",
    "GET",
    "/api/admin/staff",
    undefined,
    {
      status: 200,
      body: [
        managerExample,
        {
          ...member("inviteAdmin", "admin", "active", true),
          id: "{{inviteAdminUserId}}",
        },
        {
          ...member("inviteCheckin", "checkin_staff", "active", true),
          id: "{{inviteCheckinUserId}}",
        },
      ],
    },
    { staffList: true, finalStaffList: true },
  ),
];

export const variables = {
  staffLastActiveAt: "",
  managerCookie: "",
  inviteAdminCookie: "",
  inviteCheckinCookie: "",
  inviteAdminName: "Invited Admin",
  inviteAdminEmail: "",
  inviteAdminPassword: "",
  inviteAdminId: "",
  inviteAdminToken: "",
  oldInviteAdminToken: "",
  inviteAdminUserId: "",
  inviteAdminCreatedAt: "",
  inviteAdminLastActiveAt: "",
  inviteAdminTwoFactorAt: "",
  inviteAdminQrCode: "",
  inviteAdminSetupKey: "",
  inviteAdminAuthenticatorCode: "",
  inviteAdminChallengeId: "",
  inviteAdminDestination: "",
  inviteCheckinName: "Invited Check-in Staff",
  inviteCheckinEmail: "",
  inviteCheckinPassword: "",
  inviteCheckinId: "",
  inviteCheckinToken: "",
  inviteCheckinUserId: "",
  inviteCheckinCreatedAt: "",
  inviteCheckinLastActiveAt: "",
  inviteCheckinTwoFactorAt: "",
  inviteCheckinQrCode: "",
  inviteCheckinSetupKey: "",
  inviteCheckinAuthenticatorCode: "",
  expiredInviteName: "Expired Invite Fixture",
  expiredInviteEmail: "",
  expiredInvitePassword: "",
  expiredInviteId: "",
  expiredInviteToken: "",
};
