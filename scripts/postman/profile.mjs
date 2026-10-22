// Controller 2: AUTH-016, AUTH-017 and NOT-010. Only disposable test accounts.
const error = (status, code, message, details = {}) => ({
  status,
  body: { message, success: false, status, code, ...details },
});
const user = (prefix, fullName) => ({
  id: `{{${prefix}UserId}}`,
  fullName,
  email: `{{${prefix}Email}}`,
  phone: `{{${prefix}Phone}}`,
  roles: ["hiker"],
  status: "active",
  emailVerified: true,
  phoneVerified: false,
  photoUrl: null,
  createdAt: `{{${prefix}CreatedAt}}`,
});
const main = user("profile", "Ada Profile");
const other = user("otherProfile", "Other Hiker");
const defaults = {
  ticketConfirmations: true,
  reminders: true,
  reminderChannel: "email_whatsapp",
  promotions: false,
};
const optional = {
  dateOfBirth: "1995-02-28",
  emergencyContact: { name: "Chidi Okafor", phone: "+2348021112233" },
};
const saved = { ...main, fullName: "Ada Updated" };
const emailUser = { ...saved, email: "{{newProfileEmail}}" };
const finalUser = {
  ...emailUser,
  phone: "{{newProfilePhone}}",
  phoneVerified: true,
};
const profile = (
  account,
  extras = {},
  pendingContacts = [],
  notifications = defaults,
) => ({
  user: account,
  ...extras,
  hikesAttended: 0,
  notifications,
  pendingContacts,
});
const pending = (field) => ({
  verificationId: `{{${field}ChangeId}}`,
  field,
  value: field === "email" ? "{{newProfileEmail}}" : "{{newProfilePhone}}",
  resendAvailableAt: `{{${field}ResendAt}}`,
});
const body = {
  fullName: saved.fullName,
  email: "{{profileEmail}}",
  phone: "{{profilePhone}}",
  ...optional,
};
const emailBody = { ...body, email: "{{newProfileEmail}}" };
const phoneBody = { ...emailBody, phone: "{{newProfilePhone}}" };
const editedPrefs = {
  ticketConfirmations: true,
  reminders: false,
  reminderChannel: "email",
  promotions: true,
};
const ok = (body) => ({ status: 200, body });
let order = 0;
const entry = (name, method, path, body, expected, extra = {}) => ({
  name: `P${String(++order).padStart(2, "0")} ${name}`,
  method,
  path,
  ...(body === undefined ? {} : { body }),
  expected,
  ...extra,
});
const get = (name, path, expected) =>
  entry(name, "GET", path, undefined, expected);
const patch = (name, body, expected, extra) =>
  entry(name, "PATCH", "/api/me/profile", body, expected, extra);
const verify = (name, field, code, expected) =>
  entry(
    name,
    "POST",
    "/api/me/contact/verify",
    { verificationId: `{{${field}ChangeId}}`, code },
    expected,
  );
const resend = (name, expected, extra = {}) =>
  entry(
    name,
    "POST",
    "/api/me/contact/resend",
    { verificationId: "{{emailChangeId}}" },
    expected,
    extra,
  );
const signup = (prefix, name) =>
  entry(
    `AUTH-001 — create ${name}`,
    "POST",
    "/api/auth/user-signup",
    {
      fullName: name,
      email: `{{${prefix}Email}}`,
      phone: `{{${prefix}Phone}}`,
      password: "{{profilePassword}}",
    },
    {
      status: 201,
      body: {
        verificationId: `{{${prefix}VerificationId}}`,
        channel: "email",
        destination: `${prefix === "profile" ? "p" : "o"}•••••@example.com`,
        resendAvailableAt: `{{${prefix}ResendAvailableAt}}`,
        guestTicketsToMerge: 0,
      },
    },
    { captureVerificationAs: prefix },
  );
const signupVerify = (prefix, account) =>
  entry(
    "AUTH-005 — verify account and keep cookie",
    "POST",
    "/api/auth/user-verify",
    { verificationId: `{{${prefix}VerificationId}}`, code: "{{code}}" },
    ok({ user: account, mergedTickets: 0 }),
    { captureUserAs: prefix },
  );
const unauthenticated = error(
  401,
  "unauthenticated",
  "Please log in to continue.",
);

export const cases = [
  get("AUTH-016 — signed out", "/api/me/profile", unauthenticated),
  signup("otherProfile", "Other Hiker"),
  signupVerify("otherProfile", other),
  signup("profile", "Ada Profile"),
  signupVerify("profile", main),
  get("AUTH-016 — profile defaults", "/api/me/profile", ok(profile(main))),
  get("NOT-010 — notification defaults", "/api/me/notifications", ok(defaults)),
  patch("AUTH-016 — save profile details", body, ok(profile(saved, optional))),
  patch(
    "AUTH-016 — invalid name",
    { ...body, fullName: "" },
    error(400, "validation_error", "Enter a full name", { field: "fullName" }),
  ),
  patch(
    "AUTH-016 — invalid calendar date",
    { ...body, dateOfBirth: "2001-02-29" },
    error(
      400,
      "validation_error",
      "Enter a real date of birth, not in the future",
      { field: "dateOfBirth" },
    ),
  ),
  patch(
    "AUTH-016 — own emergency phone",
    { ...body, emergencyContact: { name: "Ada", phone: "{{profilePhone}}" } },
    error(400, "validation_error", "Use someone else’s number, not your own", {
      field: "emergencyContact.phone",
    }),
  ),
  patch(
    "AUTH-017 — duplicate verified email",
    { ...body, email: "{{otherProfileEmail}}" },
    error(409, "email_taken", "Another account already uses this email.", {
      field: "email",
    }),
  ),
  patch(
    "AUTH-017 — duplicate verified phone",
    { ...body, phone: "{{otherProfilePhone}}" },
    error(
      409,
      "phone_taken",
      "Another account already uses this phone number.",
      { field: "phone" },
    ),
  ),
  patch(
    "AUTH-017 — stage new email, keep old email",
    emailBody,
    ok(profile(saved, optional, [pending("email")])),
    { captureContact: "email" },
  ),
  patch(
    "AUTH-017 — save same pending value without resetting it",
    emailBody,
    ok(profile(saved, optional, [pending("email")])),
  ),
  resend(
    "AUTH-017 — resend too soon",
    error(
      429,
      "rate_limited",
      "Please wait a moment before asking for another code.",
      { retryAfterSeconds: 60 },
    ),
    { dynamicCooldown: true },
  ),
  ...[1, 2, 3, 4].map((attempt) =>
    verify(
      `AUTH-017 — wrong code ${attempt}`,
      "email",
      "000000",
      error(400, "invalid_code", "That code isn’t right.", {
        attemptsLeft: 5 - attempt,
      }),
    ),
  ),
  verify(
    "AUTH-017 — fifth wrong code",
    "email",
    "000000",
    error(
      410,
      "code_expired",
      "Too many wrong codes. Save your details again to get a new code.",
    ),
  ),
  verify(
    "AUTH-017 — exhausted code cannot be used",
    "email",
    "{{code}}",
    error(
      410,
      "code_expired",
      "This code has expired. Save your details again to get a new one.",
    ),
  ),
  patch(
    "AUTH-017 — save again to get a new code",
    emailBody,
    ok(profile(saved, optional, [pending("email")])),
    { captureContact: "email" },
  ),
  resend(
    "AUTH-017 — resend after real cooldown, same ID",
    ok(profile(saved, optional, [pending("email")])),
    { captureContact: "email", waitForContactResend: true },
  ),
  verify(
    "AUTH-017 — verify email and replace old value",
    "email",
    "{{code}}",
    ok(profile(emailUser, optional)),
  ),
  verify(
    "AUTH-017 — email code is single use",
    "email",
    "{{code}}",
    error(
      410,
      "code_expired",
      "This code has expired. Save your details again to get a new one.",
    ),
  ),
  patch(
    "AUTH-017 — stage phone (development SMS TODO)",
    phoneBody,
    ok(profile(emailUser, optional, [pending("phone")])),
    { captureContact: "phone" },
  ),
  verify(
    "AUTH-017 — verify phone",
    "phone",
    "{{code}}",
    ok(profile(finalUser, optional)),
  ),
  patch(
    "AUTH-017 — stage a cancellable email change",
    { ...phoneBody, email: "{{cancelProfileEmail}}" },
    ok(
      profile(finalUser, optional, [
        { ...pending("email"), value: "{{cancelProfileEmail}}" },
      ]),
    ),
    { captureContact: "email" },
  ),
  entry(
    "AUTH-017 — log in as another hiker",
    "POST",
    "/api/auth/user-login",
    {
      identifier: "{{otherProfileEmail}}",
      password: "{{profilePassword}}",
      remember: false,
    },
    ok(other),
  ),
  verify(
    "AUTH-017 — another hiker cannot verify the change",
    "email",
    "{{code}}",
    error(
      410,
      "code_expired",
      "This code has expired. Save your details again to get a new one.",
    ),
  ),
  resend(
    "AUTH-017 — another hiker cannot resend the change",
    error(
      410,
      "code_expired",
      "This change has expired. Save your details again.",
    ),
  ),
  entry(
    "AUTH-017 — another hiker cannot cancel the change",
    "DELETE",
    "/api/me/contact/{{emailChangeId}}",
    undefined,
    ok(profile(other)),
  ),
  entry(
    "AUTH-017 — return to the owner",
    "POST",
    "/api/auth/user-login",
    {
      identifier: "{{newProfileEmail}}",
      password: "{{profilePassword}}",
      remember: false,
    },
    ok(finalUser),
  ),
  entry(
    "AUTH-017 — cancel and retain current email",
    "DELETE",
    "/api/me/contact/{{emailChangeId}}",
    undefined,
    ok(profile(finalUser, optional)),
  ),
  verify(
    "AUTH-017 — cancelled code cannot be used",
    "email",
    "{{code}}",
    error(
      410,
      "code_expired",
      "This code has expired. Save your details again to get a new one.",
    ),
  ),
  entry(
    "NOT-010 — turn reminders off and opt into promotions",
    "PUT",
    "/api/me/notifications",
    { reminders: false, reminderChannel: "email", promotions: true },
    ok(editedPrefs),
  ),
  get(
    "NOT-010 — read saved preferences",
    "/api/me/notifications",
    ok(editedPrefs),
  ),
  entry(
    "NOT-010 — confirmations cannot be disabled",
    "PUT",
    "/api/me/notifications",
    { ...editedPrefs, ticketConfirmations: false },
    ok(editedPrefs),
  ),
  entry(
    "NOT-010 — invalid reminder channel",
    "PUT",
    "/api/me/notifications",
    { reminders: true, reminderChannel: "sms", promotions: false },
    error(
      400,
      "validation_error",
      "Invalid enum value. Expected 'email_whatsapp' | 'email' | 'whatsapp', received 'sms'",
      { field: "reminderChannel" },
    ),
  ),
  get(
    "AUTH-016 — final profile and preferences",
    "/api/me/profile",
    ok(profile(finalUser, optional, [], editedPrefs)),
  ),
  entry(
    "AUTH-012 — logout",
    "POST",
    "/api/auth/user-logout",
    {},
    { status: 204 },
  ),
  get("AUTH-016 — signed out again", "/api/me/profile", unauthenticated),
  entry(
    "AUTH-017 — old email no longer logs in",
    "POST",
    "/api/auth/user-login",
    {
      identifier: "{{profileEmail}}",
      password: "{{profilePassword}}",
      remember: false,
    },
    error(401, "invalid_credentials", "Incorrect email or password.", {
      attemptsLeft: 4,
      lockMinutes: 15,
    }),
  ),
  entry(
    "AUTH-017 — new email logs in",
    "POST",
    "/api/auth/user-login",
    {
      identifier: "{{newProfileEmail}}",
      password: "{{profilePassword}}",
      remember: false,
    },
    ok(finalUser),
  ),
  get(
    "AUTH-016 — profile persists after login",
    "/api/me/profile",
    ok(profile(finalUser, optional, [], editedPrefs)),
  ),
  entry(
    "AUTH-012 — finish logged out",
    "POST",
    "/api/auth/user-logout",
    {},
    { status: 204 },
  ),
];

export const variables = Object.fromEntries(
  [
    "profileEmail",
    "profilePhone",
    "otherProfileEmail",
    "otherProfilePhone",
    "newProfileEmail",
    "newProfilePhone",
    "cancelProfileEmail",
    "profilePassword",
    "profileUserId",
    "profileCreatedAt",
    "otherProfileUserId",
    "otherProfileCreatedAt",
    "profileVerificationId",
    "profileResendAvailableAt",
    "otherProfileVerificationId",
    "otherProfileResendAvailableAt",
    "emailChangeId",
    "emailResendAt",
    "phoneChangeId",
    "phoneResendAt",
  ].map((name) => [name, ""]),
);
