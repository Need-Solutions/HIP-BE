// EVT-001–EVT-012, WEB-006/011, SRCH-007. Examples only; credentials belong in a private environment.
const failure = (status, code, message, field) => ({
  status,
  body: { message, success: false, status, code, ...(field ? { field } : {}) },
});
const event = (status = "published") => ({
  id: "{{eventId}}",
  slug: "{{eventSlug}}",
  title: ["sales_closed", "cancelled"].includes(status)
    ? "Updated ridge day hike"
    : "{{eventTitle}}",
  description: "A guided ridge hike with trail guides and first aid support.",
  ...(status === "draft" ? {} : { coverImageUrl: "{{eventCoverUrl}}" }),
  startsAt: "{{eventDay}}T05:00:00.000Z",
  durationLabel: "About 6 hrs",
  meetingPoint: "Main park gate",
  location: "Abuja",
  difficulty: "moderate",
  capacity: 20,
  registrationDeadline: "{{eventDay}}T03:00:00.000Z",
  requiredEquipment: ["Water", "Walking shoes"],
  emergencyInfo: "Meet the guide at the gate. First aid is available.",
  requirements: "Arrive 15 minutes early",
  status,
  ticketsSold: 0,
  fromPriceKobo: 0,
});
const type = (name, quantityLimit, priceKobo, id) => ({
  id,
  name,
  description: "Guide included",
  quantityLimit,
  priceKobo,
  salesStart: "{{eventSalesDay}}",
  salesEnd: "{{eventDay}}",
});
const types = () => [
  type("Standard", 10, 1500000, "{{eventStandardTypeId}}"),
  type("Community", 10, 0, "{{eventFreeTypeId}}"),
];
const publicTypes = () =>
  types().map((ticket) => ({
    id: ticket.id,
    eventId: "{{eventId}}",
    name: ticket.name,
    description: ticket.description,
    priceKobo: ticket.priceKobo,
    currency: "NGN",
    quantityLimit: ticket.quantityLimit,
    quantitySold: 0,
    salesStart: "{{eventSalesStartUtc}}",
    salesEnd: "{{eventDay}}T22:59:00.000Z",
    status: "active",
  }));
export const input = () => ({
  title: "{{eventTitle}}",
  description: "A guided ridge hike with trail guides and first aid support.",
  date: "{{eventDay}}",
  startTime: "06:00",
  durationLabel: "About 6 hrs",
  meetingPoint: "Main park gate",
  location: "Abuja",
  difficulty: "moderate",
  capacity: 20,
  requiredEquipment: ["Water", "Walking shoes"],
  emergencyInfo: "Meet the guide at the gate. First aid is available.",
  requirements: "Arrive 15 minutes early",
  ticketTypes: types(),
});
const check = (label, expression) =>
  `pm.test(${JSON.stringify(label)}, function () { pm.expect(${expression}).to.eql(true); });`;
const eventChecks = (value = "body") => [
  check(
    "Exact event fields",
    `JSON.stringify(Object.keys(${value}).filter(k => !["coverImageUrl", "distanceKm", "elevationM"].includes(k)).sort()) === JSON.stringify(["id", "slug", "title", "description", "startsAt", "durationLabel", "meetingPoint", "location", "difficulty", "capacity", "registrationDeadline", "requiredEquipment", "emergencyInfo", "requirements", "status", "ticketsSold", "fromPriceKobo"].sort())`,
  ),
  check(
    "Dates are UTC",
    `${value}.startsAt.endsWith("Z") && ${value}.registrationDeadline.endsWith("Z") && !Number.isNaN(Date.parse(${value}.startsAt))`,
  ),
];
const contains = (value, expected = true) =>
  check(
    "Created event visibility",
    `${value}.some(e => e.id === pm.variables.get("eventId")) === ${expected}`,
  );
let index = 0;
const item = (label, method, path, body, expected, extra = {}) => ({
  name: `E${String(++index).padStart(2, "0")} EVT-001–EVT-012 — ${label}`,
  method,
  path,
  ...(body === undefined ? {} : { body }),
  expected,
  eventsController: true,
  cookieVar: "managerCookie",
  ...extra,
});
const publicGet = (label, path, expected, eventAssertions) =>
  item(label, "GET", path, undefined, expected, {
    cookieVar: undefined,
    ...(eventAssertions ? { eventAssertions } : {}),
  });
const update = (label, body, expected, extra = {}) =>
  item(label, "PUT", "/api/admin/events/{{eventId}}", body, expected, extra);
const saved = (status) => ({
  status: 200,
  body: { event: event(status), ticketTypes: publicTypes() },
});
const persistedChecks = (status) => [
  ...eventChecks("body.event"),
  check("Saved status", `body.event.status === ${JSON.stringify(status)}`),
  check(
    "Sold counters stay server-owned",
    "body.event.ticketsSold === 0 && body.ticketTypes.every(t => t.quantitySold === 0)",
  ),
];
const pageExample = {
  status: 200,
  body: { items: [event()], total: 1, page: 1, pageSize: 9 },
};
const pageChecks = [
  check(
    "Pagination",
    "Array.isArray(body.items) && body.page === 1 && body.pageSize === 9 && Number.isInteger(body.total)",
  ),
  contains("body.items"),
];
const withoutIds = () =>
  input().ticketTypes.map((ticket) => {
    const result = { ...ticket };
    delete result.id;
    return result;
  });

export const cases = [
  item(
    "super admin password step",
    "POST",
    "/api/auth/staff/login",
    { email: "{{staffEmail}}", password: "{{staffPassword}}" },
    {
      status: 200,
      body: { challengeId: "{{eventStaffChallenge}}", method: "authenticator" },
    },
    {
      cookieVar: undefined,
      capture: { eventStaffChallenge: "challengeId" },
      eventAssertions: [
        check("Enrolled staff challenge", 'body.method === "authenticator"'),
      ],
    },
  ),
  item(
    "super admin authenticator step",
    "POST",
    "/api/auth/staff/verify",
    {
      challengeId: "{{eventStaffChallenge}}",
      code: "{{staffAuthenticatorCode}}",
    },
    {
      status: 200,
      body: {
        id: "{{staffUserId}}",
        fullName: "{{staffName}}",
        email: "{{staffEmail}}",
        phone: "",
        roles: ["super_admin"],
        status: "active",
        emailVerified: true,
        phoneVerified: false,
        createdAt: "{{staffCreatedAt}}",
      },
    },
    {
      cookieVar: undefined,
      captureCookieAs: "managerCookie",
      capture: { staffUserId: "id", staffCreatedAt: "createdAt" },
      eventAssertions: [
        check(
          "Staff identity only",
          'body.roles.includes("super_admin") && !("token" in body) && !("passwordHash" in body) && !("authenticatorSecret" in body)',
        ),
      ],
      prepareEventTotp: true,
    },
  ),
  item(
    "create a title-only draft",
    "POST",
    "/api/admin/events",
    { title: "{{eventTitle}}" },
    {
      status: 200,
      body: {
        event: {
          ...event("draft"),
          description: "",
          startsAt: "{{eventDraftStartsAt}}",
          durationLabel: "",
          meetingPoint: "",
          location: "",
          capacity: 0,
          registrationDeadline: "{{eventDraftDeadline}}",
          requiredEquipment: [],
          emergencyInfo: "",
          requirements: "",
        },
        ticketTypes: [],
      },
    },
    {
      capture: {
        eventId: "event.id",
        eventSlug: "event.slug",
        eventDraftStartsAt: "event.startsAt",
        eventDraftDeadline: "event.registrationDeadline",
      },
      eventAssertions: [
        ...persistedChecks("draft"),
        check("Empty ticket types", "body.ticketTypes.length === 0"),
      ],
    },
  ),
  publicGet(
    "draft is not visible by ID",
    "/api/events/{{eventId}}",
    failure(404, "not_found", "Event not found."),
  ),
  publicGet(
    "unknown slug has the same response",
    "/api/events/no-such-hike-controller5",
    failure(404, "not_found", "Event not found."),
  ),
  update(
    "cannot publish without ticket types",
    { ...input(), ticketTypes: [], publish: true },
    failure(
      422,
      "validation_error",
      "Add at least one ticket type.",
      "ticketTypes",
    ),
  ),
  update(
    "save details and paid/free ticket types",
    { ...input(), ticketTypes: withoutIds(), publish: false },
    saved("draft"),
    {
      capture: {
        eventStandardTypeId: "ticketTypes.0.id",
        eventFreeTypeId: "ticketTypes.1.id",
      },
      eventAssertions: [
        ...persistedChecks("draft"),
        check(
          "Free minimum and default deadline",
          'body.event.fromPriceKobo === 0 && body.event.registrationDeadline === pm.variables.get("eventDay") + "T03:00:00.000Z"',
        ),
      ],
    },
  ),
  item(
    "wrong cover file type",
    "POST",
    "/api/admin/uploads/cover",
    undefined,
    failure(
      400,
      "invalid_file_type",
      "Choose a JPG, PNG or WebP image.",
      "image",
    ),
    { multipart: "coverWrongFile" },
  ),
  item(
    "cover larger than 5 MB",
    "POST",
    "/api/admin/uploads/cover",
    undefined,
    failure(
      413,
      "file_too_large",
      "Choose an image no larger than 5 MB.",
      "image",
    ),
    { multipart: "coverLargeFile" },
  ),
  item(
    "upload JPG, PNG or WebP cover",
    "POST",
    "/api/admin/uploads/cover",
    undefined,
    { status: 200, body: { url: "{{eventCoverUrl}}" } },
    {
      multipart: "coverFile",
      capture: { eventCoverUrl: "url" },
      eventAssertions: [
        check(
          "Secure cover URL only",
          'Object.keys(body).length === 1 && body.url.startsWith("https://")',
        ),
      ],
    },
  ),
  update(
    "publish the saved event with its cover",
    { ...input(), coverImageUrl: "{{eventCoverUrl}}", publish: true },
    saved("published"),
    {
      eventAssertions: [
        ...persistedChecks("published"),
        check(
          "Published cover",
          'body.event.coverImageUrl === pm.variables.get("eventCoverUrl")',
        ),
      ],
    },
  ),
  publicGet(
    "upcoming list returns an array",
    "/api/events?upcoming=true",
    { status: 200, body: [event()] },
    [
      check(
        "Upcoming shape",
        'Array.isArray(body) && body.every(e => !["draft", "cancelled"].includes(e.status))',
      ),
      contains("body"),
    ],
  ),
  publicGet(
    "search, UTC date bounds and pages",
    "/api/events?q={{eventTitle}}&from={{eventDay}}T00:00:00.000Z&to={{eventDay}}T23:59:59.999Z&page=1&pageSize=9",
    pageExample,
    pageChecks,
  ),
  publicGet(
    "details by slug",
    "/api/events/{{eventSlug}}",
    { status: 200, body: event() },
    [
      ...eventChecks(),
      check("Slug identity", 'body.id === pm.variables.get("eventId")'),
    ],
  ),
  publicGet(
    "details by ID",
    "/api/events/{{eventId}}",
    { status: 200, body: event() },
    eventChecks(),
  ),
  publicGet(
    "public ticket types and remaining quantities",
    "/api/events/{{eventId}}/ticket-types",
    {
      status: 200,
      body: publicTypes(),
    },
    [
      check(
        "Ticket availability",
        'body.length === 2 && body.every(t => t.eventId === pm.variables.get("eventId") && t.currency === "NGN" && t.quantityLimit - t.quantitySold === 10 && t.status === "active" && t.salesStart.endsWith("Z") && t.salesEnd.endsWith("Z"))',
      ),
    ],
  ),
  publicGet(
    "search includes the meeting point",
    "/api/events?q=main%20park&pageSize=9",
    pageExample,
    pageChecks,
  ),
  publicGet(
    "open status follows purchaseBlocker",
    "/api/events?status=open",
    pageExample,
    pageChecks,
  ),
  publicGet("latest sort", "/api/events?sort=latest", pageExample, [
    contains("body.items"),
    check(
      "Newest first",
      "body.items.every((e,i,a) => i === 0 || a[i-1].startsAt >= e.startsAt)",
    ),
  ]),
  item(
    "admin tabs and pagination",
    "GET",
    "/api/admin/events?status=published&range=upcoming&page=1",
    undefined,
    {
      status: 200,
      body: {
        items: [
          {
            event: event(),
            confirmed: 0,
            capacity: 20,
            checkedIn: null,
            revenueKobo: 0,
            refunded: false,
            salesClosing: false,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 9,
        counts: {
          all: 1,
          draft: 0,
          published: 1,
          sales_closed: 0,
          completed: 0,
          cancelled: 0,
        },
      },
    },
    {
      eventAssertions: [
        check(
          "Admin row and counts",
          'body.pageSize === 9 && body.items.some(r => r.event.id === pm.variables.get("eventId") && r.confirmed === 0 && r.checkedIn === null && r.revenueKobo === 0 && r.refunded === false) && body.counts.published >= 1',
        ),
      ],
    },
  ),
  update(
    "edit a published event and preserve its slug",
    { title: "Updated ridge day hike" },
    {
      status: 200,
      body: {
        ...saved("published").body,
        event: { ...event(), title: "Updated ridge day hike" },
      },
    },
    {
      eventAssertions: [
        ...persistedChecks("published"),
        check(
          "Stable slug",
          'body.event.slug === pm.variables.get("eventSlug") && body.event.title === "Updated ridge day hike"',
        ),
      ],
    },
  ),
  update(
    "ticket limits cannot exceed capacity",
    { ...input(), capacity: 19 },
    failure(
      422,
      "validation_error",
      "Ticket quantity limits can’t exceed the event capacity.",
      "ticketTypes",
    ),
  ),
  update(
    "negative ticket price",
    { ...input(), ticketTypes: [{ ...types()[0], priceKobo: -1 }] },
    failure(
      400,
      "validation_error",
      "Number must be greater than or equal to 0",
      "ticketTypes.0.priceKobo",
    ),
  ),
  item(
    "non-admin staff cannot manage events",
    "POST",
    "/api/admin/events",
    { title: "Blocked draft" },
    failure(403, "forbidden", "You don’t have permission to do that."),
    { cookieVar: "eventNonAdminCookie" },
  ),
  item(
    "no staff session",
    "POST",
    "/api/admin/events",
    { title: "Blocked draft" },
    failure(401, "unauthenticated", "Please sign in as staff to continue."),
    { cookieVar: undefined },
  ),
  item(
    "close ticket sales",
    "POST",
    "/api/admin/events/{{eventId}}/close-sales",
    {},
    { status: 200, body: event("sales_closed") },
    {
      eventAssertions: [
        ...eventChecks(),
        check("Sales closed", 'body.status === "sales_closed"'),
      ],
    },
  ),
  publicGet(
    "closed sales disappear from open results",
    "/api/events?status=open",
    { status: 200, body: { items: [], total: 0, page: 1, pageSize: 9 } },
    [contains("body.items", false)],
  ),
  item(
    "cancellation needs a reason",
    "POST",
    "/api/admin/events/{{eventId}}/cancel",
    { reason: "short" },
    failure(
      400,
      "validation_error",
      "Give a reason of at least 10 characters.",
      "reason",
    ),
  ),
  item(
    "cancel with a reason",
    "POST",
    "/api/admin/events/{{eventId}}/cancel",
    { reason: "Unsafe weather on the ridge" },
    { status: 200, body: event("cancelled") },
    {
      eventAssertions: [
        ...eventChecks(),
        check("Cancelled", 'body.status === "cancelled"'),
      ],
    },
  ),
  publicGet(
    "cancelled event is not upcoming",
    "/api/events?upcoming=true",
    { status: 200, body: [] },
    [contains("body", false)],
  ),
  publicGet(
    "cancelled detail explains its status",
    "/api/events/{{eventSlug}}",
    { status: 200, body: event("cancelled") },
    [
      ...eventChecks(),
      check(
        "Cancellation remains visible by link",
        'body.status === "cancelled"',
      ),
    ],
  ),
  update(
    "cancelled events cannot be edited",
    { title: "Blocked edit" },
    failure(409, "event_locked", "A cancelled event can’t be edited."),
  ),
  item(
    "admin cancelled tab",
    "GET",
    "/api/admin/events?status=cancelled&range=all&page=1",
    undefined,
    {
      status: 200,
      body: {
        items: [
          {
            event: event("cancelled"),
            confirmed: 0,
            capacity: 20,
            checkedIn: null,
            revenueKobo: 0,
            refunded: false,
            salesClosing: false,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 9,
        counts: {
          all: 1,
          draft: 0,
          published: 0,
          sales_closed: 0,
          completed: 0,
          cancelled: 1,
        },
      },
    },
    {
      eventAssertions: [
        check(
          "Cancelled count",
          'body.counts.cancelled >= 1 && body.items.some(r => r.event.id === pm.variables.get("eventId") && r.event.status === "cancelled" && r.refunded === false)',
        ),
      ],
    },
  ),
  publicGet(
    "past status returns only past hikes",
    "/api/events?status=past",
    { status: 200, body: { items: [], total: 0, page: 1, pageSize: 9 } },
    [
      check(
        "Past follows the frontend rule",
        'body.items.every(e => e.status === "completed" || Date.parse(e.startsAt) < Date.now())',
      ),
    ],
  ),
  item("staff logout", "POST", "/api/auth/staff/logout", {}, { status: 204 }),
];
export const variables = {
  eventTitle: "Gurara ridge day hike",
  eventDay: "",
  eventSalesDay: "",
  eventSalesStartUtc: "",
  eventDraftStartsAt: "",
  eventDraftDeadline: "",
  eventId: "",
  eventSlug: "",
  eventCoverUrl: "",
  eventStandardTypeId: "",
  eventFreeTypeId: "",
  eventStaffChallenge: "",
  eventNonAdminCookie: "",
  coverFile: "",
  coverWrongFile: "",
  coverLargeFile: "",
};
export const initialize = [
  'if (!pm.variables.get("eventDay")) pm.environment.set("eventDay", new Date(Date.now() + 7 * 86400000).toISOString().slice(0,10));',
  'if (!pm.variables.get("eventSalesDay")) pm.environment.set("eventSalesDay", new Date().toISOString().slice(0,10));',
  'pm.environment.set("eventSalesStartUtc", new Date(pm.variables.get("eventSalesDay") + "T00:00:00+01:00").toISOString());',
];
