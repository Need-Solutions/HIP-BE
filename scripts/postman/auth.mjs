// Controller 1 only. AUTH-001–AUTH-013; ticket linking (AUTH-006) is a TODO.
const error = (status, code, message, details = {}) => ({
  status,
  body: { message, success: false, status, code, ...details },
});
const signup = {
  fullName: "Ada Okafor",
  email: "{{email}}",
  phone: "{{phone}}",
  password: "{{password}}",
};
const verification = {
  verificationId: "{{verificationId}}",
  channel: "email",
  destination: "a•••••@example.com",
  resendAvailableAt: "{{resendAvailableAt}}",
  guestTicketsToMerge: 0,
};
const user = {
  id: "{{userId}}",
  fullName: "Ada Okafor",
  email: "{{email}}",
  phone: "{{phone}}",
  roles: ["hiker"],
  status: "active",
  emailVerified: true,
  phoneVerified: false,
  createdAt: "{{createdAt}}",
};
const invalidCredentials = (attemptsLeft) =>
  error(401, "invalid_credentials", "Incorrect email or password.", {
    attemptsLeft,
    lockMinutes: 15,
  });
const locked = error(
  423,
  "locked",
  "Too many attempts. Try again in 15 minutes.",
  {
    retryAfterSeconds: 900,
    lockMinutes: 15,
  },
);
const post = (name, path, body, expected, extra = {}) => ({
  name,
  method: "POST",
  path: `/api/auth/user-${path}`,
  body,
  expected,
  ...extra,
});

export const cases = [
  {
    name: "01 AUTH-012 — no session",
    method: "GET",
    path: "/api/auth/me",
    expected: { status: 200, body: null },
  },
  post(
    "02 AUTH-001 — signup",
    "signup",
    signup,
    { status: 201, body: verification },
    { captureVerification: true },
  ),
  post(
    "03 AUTH-005 — resend too soon",
    "verify/resend",
    { verificationId: "{{verificationId}}", channel: "email" },
    error(
      429,
      "rate_limited",
      "Please wait 60 seconds before requesting another code.",
      { retryAfterSeconds: 60 },
    ),
    { dynamicCooldown: true },
  ),
  ...[1, 2, 3, 4].map((attempt) =>
    post(
      `0${attempt + 3} AUTH-005 — wrong code ${attempt}`,
      "verify",
      { verificationId: "{{verificationId}}", code: "000000" },
      error(400, "invalid_code", "That code isn’t right.", {
        attemptsLeft: 5 - attempt,
      }),
    ),
  ),
  post(
    "08 AUTH-005 — fifth wrong code",
    "verify",
    { verificationId: "{{verificationId}}", code: "000000" },
    error(410, "code_expired", "Too many wrong codes. Request a new one."),
  ),
  post(
    "09 AUTH-005 — correct code after exhaustion",
    "verify",
    { verificationId: "{{verificationId}}", code: "{{code}}" },
    error(410, "code_expired", "This code has expired. Request a new one."),
  ),
  post(
    "10 AUTH-001 — replace unfinished signup",
    "signup",
    signup,
    { status: 201, body: verification },
    { captureVerification: true },
  ),
  post(
    "11 AUTH-005 — resend after 60 seconds",
    "verify/resend",
    { verificationId: "{{verificationId}}", channel: "email" },
    { status: 200, body: verification },
    { waitForResend: true, captureVerification: true, rotate: true },
  ),
  post(
    "12 AUTH-005 — old verification ID is invalid",
    "verify",
    { verificationId: "{{oldVerificationId}}", code: "{{code}}" },
    error(410, "code_expired", "This code has expired. Request a new one."),
  ),
  post(
    "13 AUTH-006 — verify and sign in",
    "verify",
    { verificationId: "{{verificationId}}", code: "{{code}}" },
    { status: 200, body: { user, mergedTickets: 0 } },
    { captureUser: true },
  ),
  {
    name: "14 AUTH-012 — current user",
    method: "GET",
    path: "/api/auth/me",
    expected: { status: 200, body: user },
  },
  post(
    "15 AUTH-004 — duplicate email",
    "signup",
    { ...signup, phone: "{{otherPhone}}" },
    error(409, "email_taken", "An account with this email already exists.", {
      field: "email",
    }),
  ),
  post(
    "16 AUTH-004 — duplicate phone",
    "signup",
    { ...signup, email: "{{otherEmail}}" },
    error(
      409,
      "phone_taken",
      "An account with this phone number already exists.",
      { field: "phone" },
    ),
  ),
  post(
    "17 AUTH-008 — email login",
    "login",
    { identifier: "{{email}}", password: "{{password}}", remember: false },
    { status: 200, body: user },
  ),
  post(
    "18 AUTH-008 — phone login and remember me",
    "login",
    { identifier: "{{phone}}", password: "{{password}}", remember: true },
    { status: 200, body: user },
  ),
  post("19 AUTH-012 — logout", "logout", {}, { status: 204 }),
  {
    name: "20 AUTH-012 — logged out",
    method: "GET",
    path: "/api/auth/me",
    expected: { status: 200, body: null },
  },
  post(
    "21 AUTH-009 — unknown identifier",
    "login",
    { identifier: "{{otherEmail}}", password: "{{password}}", remember: false },
    invalidCredentials(4),
  ),
  ...[1, 2, 3, 4].map((attempt) =>
    post(
      `${attempt + 21} AUTH-013 — wrong password ${attempt}`,
      "login",
      {
        identifier: "{{email}}",
        password: "{{wrongPassword}}",
        remember: false,
      },
      invalidCredentials(5 - attempt),
    ),
  ),
  post(
    "26 AUTH-013 — fifth wrong password locks login",
    "login",
    { identifier: "{{email}}", password: "{{wrongPassword}}", remember: false },
    locked,
  ),
  post(
    "27 AUTH-013 — correct password during lock",
    "login",
    { identifier: "{{email}}", password: "{{password}}", remember: false },
    locked,
  ),
  post(
    "28 AUTH-010 — forgot known email",
    "forgot",
    { email: "{{email}}" },
    { status: 204 },
    { captureReset: true },
  ),
  post(
    "29 AUTH-010 — forgot unknown email",
    "forgot",
    { email: "{{otherEmail}}" },
    { status: 204 },
  ),
  post(
    "30 AUTH-010 — reject current password reuse",
    "reset",
    { token: "{{resetToken}}", password: "{{password}}" },
    error(
      400,
      "password_reused",
      "Choose a password you haven’t used on HIP before.",
      { field: "password" },
    ),
  ),
  post(
    "31 AUTH-010 — reset password",
    "reset",
    { token: "{{resetToken}}", password: "{{newPassword}}" },
    { status: 204 },
  ),
  post(
    "32 AUTH-010 — reset token cannot be reused",
    "reset",
    { token: "{{resetToken}}", password: "{{password}}" },
    error(
      400,
      "token_invalid",
      "This reset link has expired or was already used.",
    ),
  ),
  post(
    "33 AUTH-008 — old password no longer works",
    "login",
    { identifier: "{{email}}", password: "{{password}}", remember: false },
    invalidCredentials(4),
  ),
  post(
    "34 AUTH-008 — new password works",
    "login",
    { identifier: "{{email}}", password: "{{newPassword}}", remember: false },
    { status: 200, body: user },
  ),
  post("35 AUTH-012 — finish logged out", "logout", {}, { status: 204 }),
];

export const variables = {
  baseUrl: "http://localhost:5001",
  email: "",
  phone: "",
  otherEmail: "",
  otherPhone: "",
  password: "",
  wrongPassword: "",
  newPassword: "",
  code: "123456",
  verificationId: "",
  oldVerificationId: "",
  resendAvailableAt: "",
  userId: "",
  createdAt: "",
  resetToken: "",
};
