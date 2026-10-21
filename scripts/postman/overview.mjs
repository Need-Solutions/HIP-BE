// ANA-001–ANA-004. Private cookies only; no credentials or provider keys belong in this folder.
export const variables = {
  overviewAdminCookie: "",
  overviewCheckinCookie: "",
  overviewAdvertiserCookie: "",
  overviewSetupCookie: "",
};
const example = {
  weekStart: "2026-10-18T23:00:00.000Z",
  weekEnd: "2026-10-25T22:59:59.999Z",
  registeredHikers: 1,
  attendance: { instances: 0, uniqueHikers: 0, previousInstances: 0 },
  ticketsSold: { value: 1, previous: 0 },
  testRevenueKobo: { value: 0, previous: 0 },
  netRevenueKobo: { value: 250000, previous: 0 },
  weekly: Array.from({ length: 8 }, (_, index) => ({
    week: `W${36 + index}`,
    startsOn: new Date(
      Date.parse("2026-08-30T23:00:00Z") + index * 604800000,
    ).toISOString(),
    instances: 0,
    uniqueHikers: 0,
  })),
  upcoming: [],
  activity: [],
  pendingRefunds: 0,
};
const assertions = [
  'pm.test("Direct OverviewStats contract", function () { pm.expect(Object.keys(body).sort()).to.deep.eql(["weekStart","weekEnd","registeredHikers","attendance","ticketsSold","netRevenueKobo","testRevenueKobo","weekly","upcoming","activity","pendingRefunds"].sort()); });',
  'pm.test("Actual counts and integer kobo", function () { for (const n of [body.registeredHikers,body.attendance.instances,body.attendance.uniqueHikers,body.attendance.previousInstances,body.ticketsSold.value,body.ticketsSold.previous,body.netRevenueKobo.value,body.netRevenueKobo.previous,body.pendingRefunds]) pm.expect(Number.isSafeInteger(n)).to.eql(true); });',
  'pm.test("Africa/Lagos Monday-to-Sunday week", function () { const start = Date.parse(body.weekStart), end = Date.parse(body.weekEnd); const local = new Date(start + 3600000); pm.expect(local.getUTCDay()).to.eql(1); pm.expect(local.getUTCHours()).to.eql(0); pm.expect(end-start).to.eql(604800000-1); });',
  'pm.test("Eight attendance weeks; sales are not check-ins", function () { pm.expect(body.weekly.length).to.eql(8); pm.expect(body.attendance).to.deep.eql({instances:0,uniqueHikers:0,previousInstances:0}); body.weekly.forEach(w => { pm.expect(w.instances).to.eql(0); pm.expect(w.uniqueHikers).to.eql(0); }); });',
  'pm.test("Bounded public activity and event fields", function () { pm.expect(body.upcoming.length <= 4).to.eql(true); pm.expect(body.activity.length <= 4).to.eql(true); pm.expect(/passwordHash|authenticatorSecret|ownerHash|requestHash|paystackAccessCode|qrToken/.test(JSON.stringify(body))).to.eql(false); });',
];
const item = (name, cookieVar, status = 200, code, message, extra = {}) => ({
  name,
  overviewController: true,
  method: "GET",
  path: "/api/admin/overview",
  cookieVar,
  expected: {
    status,
    body: status === 200 ? example : { message, success: false, status, code },
  },
  ...(status === 200 ? { overviewAssertions: assertions } : {}),
  ...extra,
});
export const cases = [
  item("O01 Super admin — current totals", "managerCookie"),
  item(
    "O02 Admin — current totals and operational activity",
    "overviewAdminCookie",
  ),
  item(
    "O03 Guest cannot read totals",
    undefined,
    401,
    "unauthenticated",
    "Please sign in as staff to continue.",
  ),
  item(
    "O04 Check-in staff cannot read totals",
    "overviewCheckinCookie",
    403,
    "forbidden",
    "You don’t have permission to do that.",
  ),
  item(
    "O05 Advertiser cannot read totals",
    "overviewAdvertiserCookie",
    403,
    "forbidden",
    "You don’t have permission to do that.",
  ),
  item(
    "O06 Authenticator setup must be completed",
    "overviewSetupCookie",
    403,
    "two_step_required",
    "Set up your authenticator to finish signing in.",
  ),
  item(
    "O07 Arbitrary reporting dates are rejected",
    "managerCookie",
    400,
    "validation_error",
    "Unrecognized key(s) in object: 'from'",
    { path: "/api/admin/overview?from=2026-01-01" },
  ),
];

const auditExample = { items: [], total: 0, page: 1, pageSize: 12, actors: [] };
const auditAssertions = [
  'pm.test("Direct AuditPage contract", function () { pm.expect(Object.keys(body).sort()).to.deep.eql(["items","total","page","pageSize","actors"].sort()); pm.expect(Array.isArray(body.items) && Array.isArray(body.actors)).to.eql(true); pm.expect(Number.isSafeInteger(body.total)).to.eql(true); });',
  'pm.test("Immutable entries have only public response fields", function () { body.items.forEach(e => { for (const key of ["id","actorUserId","actorName","action","recordType","recordId","recordLabel","details","createdAt"]) pm.expect(typeof e[key]).to.eql("string"); pm.expect(Number.isNaN(Date.parse(e.createdAt))).to.eql(false); }); pm.expect(/passwordHash|authenticatorSecret|ownerHash|requestHash|tokenHash|qrToken|paystackAccessCode/.test(JSON.stringify(body))).to.eql(false); });',
];
const auditItem = (
  name,
  cookieVar = "managerCookie",
  path = "/api/admin/audit-log",
  status = 200,
  code,
  message,
) => ({
  ...item(name, cookieVar, status, code, message),
  auditController: true,
  path,
  ...(status === 200
    ? {
        expected: {
          status,
          body: {
            ...auditExample,
            ...(path.includes("all=true") ? { pageSize: 0 } : {}),
          },
        },
        overviewAssertions: auditAssertions,
      }
    : {}),
});
export const auditCases = [
  auditItem("L01 Super admin — full audit log"),
  auditItem(
    "L02 Filter ticket/payment activity",
    "managerCookie",
    "/api/admin/audit-log?action=group:payments&page=1",
  ),
  auditItem(
    "L03 Export all filtered records",
    "managerCookie",
    "/api/admin/audit-log?all=true",
  ),
  auditItem(
    "L04 Anonymous access denied",
    undefined,
    "/api/admin/audit-log",
    401,
    "unauthenticated",
    "Please sign in as staff to continue.",
  ),
  auditItem(
    "L05 Ordinary admin access denied",
    "overviewAdminCookie",
    "/api/admin/audit-log",
    403,
    "forbidden",
    "You don’t have permission to do that.",
  ),
  auditItem(
    "L06 Check-in staff access denied",
    "overviewCheckinCookie",
    "/api/admin/audit-log",
    403,
    "forbidden",
    "You don’t have permission to do that.",
  ),
  auditItem(
    "L07 Advertiser access denied",
    "overviewAdvertiserCookie",
    "/api/admin/audit-log",
    403,
    "forbidden",
    "You don’t have permission to do that.",
  ),
  auditItem(
    "L08 Authenticator setup must be completed",
    "overviewSetupCookie",
    "/api/admin/audit-log",
    403,
    "two_step_required",
    "Set up your authenticator to finish signing in.",
  ),
];
// `undefined` is intentional here: this request must not inherit a staff cookie jar.
auditCases[3].cookieVar = undefined;
