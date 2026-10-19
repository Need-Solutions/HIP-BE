// Controller 3 only: ADM-001. Runtime credentials/codes must never be exported.
const error = (status, code, message, details = {}) => ({
  status,
  body: { message, success: false, status, code, ...details },
});
const staffUser = {
  id: "{{staffUserId}}",
  fullName: "{{staffName}}",
  email: "{{staffEmail}}",
  phone: "",
  roles: ["super_admin"],
  status: "active",
  emailVerified: true,
  phoneVerified: false,
  createdAt: "{{staffCreatedAt}}",
};
const emailChallenge = {
  challengeId: "{{staffChallengeId}}",
  method: "email",
  destination: "{{staffDestination}}",
};
const totpChallenge = {
  challengeId: "{{staffChallengeId}}",
  method: "authenticator",
};
const invalid = (attemptsLeft) =>
  error(401, "invalid_credentials", "Incorrect email or password.", {
    attemptsLeft,
    lockMinutes: 15,
  });
const locked = error(
  423,
  "locked",
  "Too many attempts. Try again in 15 minutes.",
  { retryAfterSeconds: 900, lockMinutes: 15 },
);
const post = (name, path, body, expected, extra = {}) => ({
  name,
  method: "POST",
  path: `/api/auth/staff/${path}`,
  body,
  expected,
  ...extra,
});
const me = (name, expected) => ({
  name,
  method: "GET",
  path: "/api/auth/staff/me",
  expected,
});
const loginBody = { email: "{{staffEmail}}", password: "{{staffPassword}}" };
const codeBody = { challengeId: "{{staffChallengeId}}", code: "{{code}}" };

export const cases = [
  me("C01 ADM-001 — no staff session", { status: 200, body: null }),
  post(
    "C02 ADM-001 — first login emails a code",
    "login",
    loginBody,
    { status: 200, body: emailChallenge },
    { captureStaffChallenge: true },
  ),
  post(
    "C03 ADM-001 — resend too soon",
    "verify/resend",
    { challengeId: "{{staffChallengeId}}" },
    error(
      429,
      "rate_limited",
      "Please wait a moment before asking for another code.",
      { retryAfterSeconds: 60 },
    ),
    { dynamicCooldown: true },
  ),
  post(
    "C04 ADM-001 — wrong email code",
    "verify",
    { ...codeBody, code: "000000" },
    error(400, "invalid_code", "That code isn’t right.", { attemptsLeft: 4 }),
  ),
  post(
    "C05 ADM-001 — resend after cooldown",
    "verify/resend",
    { challengeId: "{{staffChallengeId}}" },
    { status: 200, body: emailChallenge },
    { waitForStaffResend: true, captureStaffChallenge: true },
  ),
  post(
    "C06 ADM-001 — email code grants setup-only cookie",
    "verify",
    codeBody,
    { status: 200, body: staffUser },
    { captureStaffUser: true },
  ),
  me(
    "C07 ADM-001 — limited session cannot access staff me",
    error(
      403,
      "two_step_required",
      "Set up your authenticator to finish signing in.",
    ),
  ),
  post(
    "C08 ADM-001 — authenticator QR and setup key",
    "two-step/setup",
    {},
    {
      status: 200,
      body: { qrCode: "{{staffQrCode}}", setupKey: "{{staffSetupKey}}" },
    },
    { captureStaffSetup: true },
  ),
  post(
    "C09 ADM-001 — wrong setup code",
    "two-step/enable",
    { code: "{{staffWrongCode}}" },
    error(
      400,
      "invalid_code",
      "That code isn’t right. Check your authenticator app.",
      { attemptsLeft: 4 },
    ),
    { prepareWrongTotp: true },
  ),
  post(
    "C10 ADM-001 — confirm setup and get a full session",
    "two-step/enable",
    { code: "{{staffAuthenticatorCode}}" },
    { status: 200, body: staffUser },
    { prepareTotp: true },
  ),
  me("C11 ADM-001 — full staff session", { status: 200, body: staffUser }),
  {
    name: "C12 ADM-001 — staff cookie is not a hiker cookie",
    method: "GET",
    path: "/api/auth/me",
    expected: { status: 200, body: null },
  },
  post(
    "C13 ADM-001 — enabled secrets cannot be read again",
    "two-step/setup",
    {},
    error(
      409,
      "two_step_enabled",
      "Your authenticator is already enabled. Please sign in again.",
    ),
  ),
  post("C14 ADM-001 — logout", "logout", {}, { status: 204 }),
  me("C15 ADM-001 — signed out", { status: 200, body: null }),
  post(
    "C16 ADM-001 — second login requires authenticator",
    "login",
    loginBody,
    { status: 200, body: totpChallenge },
    { captureStaffChallenge: true },
  ),
  post(
    "C17 ADM-001 — email fallback is forbidden",
    "verify/resend",
    { challengeId: "{{staffChallengeId}}" },
    error(
      403,
      "authenticator_required",
      "Use the code from your authenticator app.",
    ),
  ),
  post(
    "C18 ADM-001 — wrong authenticator code",
    "verify",
    { challengeId: "{{staffChallengeId}}", code: "{{staffWrongCode}}" },
    error(
      400,
      "invalid_code",
      "That code isn’t right. Check your authenticator app.",
      { attemptsLeft: 4 },
    ),
    { prepareWrongTotp: true },
  ),
  post(
    "C19 ADM-001 — authenticator login",
    "verify",
    { challengeId: "{{staffChallengeId}}", code: "{{staffAuthenticatorCode}}" },
    { status: 200, body: staffUser },
    { prepareTotp: true },
  ),
  post(
    "C20 ADM-001 — used challenge is invalid",
    "verify",
    { challengeId: "{{staffChallengeId}}", code: "{{staffAuthenticatorCode}}" },
    error(410, "code_expired", "Your sign-in timed out. Please sign in again."),
    { prepareTotp: true },
  ),
  post(
    "C21 ADM-001 — log out before failure cases",
    "logout",
    {},
    { status: 204 },
  ),
  post(
    "C22 ADM-001 — hiker cannot use staff login",
    "login",
    { email: "{{newProfileEmail}}", password: "{{profilePassword}}" },
    invalid(4),
  ),
  post(
    "C23 ADM-001 — deactivated staff wrong password stays generic",
    "login",
    { email: "{{deactivatedStaffEmail}}", password: "{{wrongPassword}}" },
    invalid(4),
  ),
  post(
    "C24 ADM-001 — deactivated staff cannot log in",
    "login",
    {
      email: "{{deactivatedStaffEmail}}",
      password: "{{deactivatedStaffPassword}}",
    },
    error(
      403,
      "suspended",
      "This staff account is deactivated. Ask a super admin.",
    ),
  ),
  post(
    "C25 ADM-001 — unknown email stays generic",
    "login",
    { email: "{{unknownStaffEmail}}", password: "{{wrongPassword}}" },
    invalid(4),
  ),
  ...[1, 2, 3, 4, 5].map((attempt) =>
    post(
      `C${25 + attempt} ADM-001 — wrong password ${attempt}`,
      "login",
      { email: "{{staffEmail}}", password: "{{wrongPassword}}" },
      attempt === 5 ? locked : invalid(5 - attempt),
    ),
  ),
  post(
    "C31 ADM-001 — correct password is blocked during lockout",
    "login",
    loginBody,
    locked,
  ),
  me("C32 ADM-001 — failures never create a session", {
    status: 200,
    body: null,
  }),
];

export const variables = {
  staffEmail: "",
  staffName: "",
  staffPassword: "",
  staffChallengeId: "",
  staffUserId: "",
  staffCreatedAt: "",
  staffDestination: "",
  staffResendAt: "",
  staffQrCode: "",
  staffSetupKey: "",
  staffAuthenticatorCode: "",
  staffWrongCode: "000000",
  deactivatedStaffEmail: "",
  deactivatedStaffPassword: "",
  unknownStaffEmail: "",
};
