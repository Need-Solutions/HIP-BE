import { randomBytes } from "crypto";
import mongoose from "mongoose";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { app } from "../app";
import bootstrap from "../bootstrap";
import { ENV } from "../config/env";
import { limiter } from "../bootstrap/rate-limiting";
import {
  AdminModel,
  AdminRole,
  type AdminDocument,
} from "../database/models/admin.schema";
import { EventModel } from "../database/models/events.schema";
import { TicketTypeModel } from "../database/models/ticket-types.schema";
import { AuditLogModel } from "../database/models/audit-log.schema";
import { createStaffSession } from "../modules/admin/services/auth-session.service";
import * as audit from "../modules/admin/services/audit-log.service";
import { uploadCover } from "../services/cover.service";

vi.mock("../services/cover.service", () => ({
  uploadCover: vi.fn().mockResolvedValue({
    url: "https://res.cloudinary.com/test/image/upload/cover.png",
  }),
}));
let owner: AdminDocument;
const cookie = (actor = owner, scope: "full" | "setup" = "full") =>
  `hip_staff_session=${createStaffSession(actor, scope).token}`;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const form = () => ({
  title: "Hill trail hike",
  description: "A guided hike along the hill trail with experienced guides.",
  date: day(7),
  startTime: "06:00",
  durationLabel: "About 6 hrs",
  meetingPoint: "Main park gate",
  location: "Abuja",
  difficulty: "moderate",
  capacity: 20,
  requiredEquipment: ["Water", "Walking shoes"],
  emergencyInfo: "Meet the guide at the gate. First aid is available.",
  requirements: "Arrive 15 minutes early",
  ticketTypes: [
    {
      name: "Standard",
      description: "Guide included",
      priceKobo: 1500000,
      quantityLimit: 20,
      salesStart: day(0),
      salesEnd: day(7),
    },
  ],
});
const post = (body: object) =>
  request(app).post("/api/admin/events").set("Cookie", cookie()).send(body);
const put = (id: string, body: object) =>
  request(app)
    .put(`/api/admin/events/${id}`)
    .set("Cookie", cookie())
    .send(body);
async function create(publish = true, patch = {}) {
  const response = await post({ ...form(), ...patch, publish });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}
beforeAll(async () => {
  if (
    !/^hip_auth_test(?:_[a-z0-9]+)?$/.test(
      new URL(ENV.MONGODB_URI).pathname.slice(1),
    )
  )
    throw new Error("Events tests require an isolated hip_auth_test database.");
  await bootstrap.handleDBConnect();
  if (!(await mongoose.connection.db!.admin().command({ hello: 1 })).setName)
    throw new Error("Events tests require a replica set.");
  await Promise.all([
    EventModel.init(),
    TicketTypeModel.init(),
    AuditLogModel.init(),
    AdminModel.init(),
  ]);
});
afterAll(async () => {
  // These fixtures never reach the developer database; deactivate even the temporary test actors.
  if (mongoose.connection.readyState === 1)
    await AdminModel.updateMany(
      {},
      { $set: { status: "deactivated" }, $inc: { sessionVersion: 1 } },
    );
  await mongoose.disconnect();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(uploadCover).mockReset().mockResolvedValue({
    url: "https://res.cloudinary.com/test/image/upload/cover.png",
  });
  await AuditLogModel.collection.deleteMany({});
  await Promise.all([
    EventModel.deleteMany({}),
    TicketTypeModel.deleteMany({}),
    AdminModel.updateMany({}, { status: "deactivated" }),
  ]);
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"])
    limiter.resetKey(key);
  owner = await AdminModel.create({
    fullName: "Event manager",
    email: `${randomBytes(8).toString("hex")}@example.com`,
    passwordHash: randomBytes(32).toString("hex"),
    role: AdminRole.SUPER_ADMIN,
    twoStepEnabled: true,
  });
});

describe("Events (EVT-001–EVT-012, WEB-006/011)", () => {
  it("allows a title-only draft, never exposes its storage fields, and does not publish a generated draft schedule", async () => {
    const response = await post({ title: "Draft hike" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      event: {
        title: "Draft hike",
        slug: "draft-hike",
        status: "draft",
        capacity: 0,
        ticketsSold: 0,
        fromPriceKobo: 0,
      },
      ticketTypes: [],
    });
    expect(new Date(response.body.event.startsAt).getUTCHours()).toBe(5);
    expect(JSON.stringify(response.body)).not.toMatch(
      /scheduleSet|_id|__v|createdAt|cancellationReason/,
    );
    expect(
      await AuditLogModel.countDocuments({ action: "event.created" }),
    ).toBe(1);
    const input: Partial<ReturnType<typeof form>> = form();
    delete input.date;
    delete input.startTime;
    const published = await put(response.body.event.id, {
      ...input,
      publish: true,
    });
    expect(published.status).toBe(422);
    expect(published.body.field).toBe("date");
  });
  it("requires ticket types on publish, defaults deadline two hours earlier, stores UTC, and publishes the exact shapes", async () => {
    const noTypes = await post({ ...form(), publish: true, ticketTypes: [] });
    expect(noTypes.status).toBe(422);
    expect(noTypes.body).toMatchObject({
      code: "validation_error",
      field: "ticketTypes",
      message: "Add at least one ticket type.",
    });
    expect(await EventModel.countDocuments()).toBe(0);
    const { event, ticketTypes } = await create();
    expect(event.startsAt).toBe(`${day(7)}T05:00:00.000Z`);
    expect(event.registrationDeadline).toBe(`${day(7)}T03:00:00.000Z`);
    expect(ticketTypes[0]).toEqual({
      id: expect.any(String),
      eventId: event.id,
      name: "Standard",
      description: "Guide included",
      priceKobo: 1500000,
      currency: "NGN",
      quantityLimit: 20,
      quantitySold: 0,
      salesStart: `${day(-1)}T23:00:00.000Z`,
      salesEnd: `${day(7)}T22:59:00.000Z`,
      status: "active",
    });
    for (const route of [event.id, event.slug])
      expect((await request(app).get(`/api/events/${route}`)).body).toEqual(
        event,
      );
    expect(
      (await request(app).get(`/api/events/${event.id}/ticket-types`)).body,
    ).toEqual(ticketTypes);
    expect(
      await AuditLogModel.countDocuments({
        action: { $in: ["event.created", "event.published"] },
      }),
    ).toBe(2);
  });
  it("keeps unique slugs stable across title edits, including concurrent creates", async () => {
    const responses = await Promise.all([create(false), create(false)]);
    expect(new Set(responses.map(({ event }) => event.slug)).size).toBe(2);
    const response = await put(responses[0].event.id, {
      title: "Changed title",
    });
    expect(response.body.event.slug).toBe(responses[0].event.slug);
  });
  it("validates calendar dates, integers, sales windows, capacity and ownership of ticket IDs", async () => {
    for (const patch of [
      { date: "2027-02-30" },
      { startTime: "25:00" },
      { capacity: 1.5 },
      { capacity: 10001 },
      { coverImageUrl: "http://example.com/cover.jpg" },
    ])
      expect((await post({ ...form(), ...patch })).status).toBe(400);
    const over = await post({ ...form(), capacity: 19 });
    expect(over.status).toBe(422);
    expect(over.body.field).toBe("ticketTypes");
    const { event, ticketTypes } = await create();
    expect(
      (
        await put(event.id, {
          ...form(),
          ticketTypes: [
            {
              ...form().ticketTypes[0],
              id: new mongoose.Types.ObjectId().toString(),
            },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put(event.id, {
          ...form(),
          ticketTypes: [ticketTypes[0], ticketTypes[0]],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put(event.id, {
          ...form(),
          ticketTypes: [{ ...form().ticketTypes[0], salesStart: day(8) }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put(event.id, {
          ...form(),
          ticketTypes: [{ ...form().ticketTypes[0], salesEnd: day(8) }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await put(event.id, {
          ...form(),
          registrationDeadline: `${day(8)}T06:00`,
        })
      ).status,
    ).toBe(422);
  });
  it("cannot lower sold limits, remove a sold type or overwrite sold counts from the client", async () => {
    const { event, ticketTypes } = await create();
    await TicketTypeModel.updateOne(
      { _id: ticketTypes[0].id },
      { quantitySold: 4 },
    );
    await EventModel.updateOne({ _id: event.id }, { ticketsSold: 4 });
    const base = {
      ...form(),
      ticketTypes: [{ ...form().ticketTypes[0], id: ticketTypes[0].id }],
    };
    const lowered = await put(event.id, {
      ...base,
      ticketTypes: [{ ...base.ticketTypes[0], quantityLimit: 3 }],
    });
    expect(lowered.status).toBe(409);
    expect(lowered.body.code).toBe("quantity_below_sold");
    expect((await put(event.id, { ticketTypes: [] })).body.code).toBe(
      "ticket_type_sold",
    );
    const response = await put(event.id, {
      ...base,
      ticketsSold: 0,
      status: "draft",
      ticketTypes: [{ ...base.ticketTypes[0], quantitySold: 0 }],
    });
    expect(response.body.event).toMatchObject({
      ticketsSold: 4,
      status: "published",
    });
    expect(response.body.ticketTypes[0].quantitySold).toBe(4);
  });
  it("edits, closes sales and cancels with an immutable audit reason, without pretending refunds exist", async () => {
    const { event } = await create();
    expect((await put(event.id, { title: "Revised title" })).status).toBe(200);
    const close = () =>
      request(app)
        .post(`/api/admin/events/${event.id}/close-sales`)
        .set("Cookie", cookie())
        .send({});
    expect((await close()).body.status).toBe("sales_closed");
    expect((await close()).status).toBe(200);
    expect(
      await AuditLogModel.countDocuments({ action: "event.sales_closed" }),
    ).toBe(1);
    const bad = await request(app)
      .post(`/api/admin/events/${event.id}/cancel`)
      .set("Cookie", cookie())
      .send({ reason: "short" });
    expect(bad.status).toBe(400);
    const reason = "Unsafe weather on the trail";
    const cancel = await request(app)
      .post(`/api/admin/events/${event.id}/cancel`)
      .set("Cookie", cookie())
      .send({ reason });
    expect(cancel.body.status).toBe("cancelled");
    expect(
      (await AuditLogModel.findOne({ action: "event.cancelled" }))?.reason,
    ).toBe(reason);
    expect((await put(event.id, { title: "Cannot edit" })).status).toBe(409);
    const list = await request(app)
      .get("/api/admin/events")
      .set("Cookie", cookie());
    expect(list.body.items[0].refunded).toBe(false);
    expect(
      (await request(app).get(`/api/events/${event.slug}`)).body.status,
    ).toBe("cancelled");
  });
  it("rolls event, types and audits back together if audit writing fails", async () => {
    vi.spyOn(audit, "recordAudit").mockRejectedValueOnce(
      new Error("Private diagnostic"),
    );
    const response = await post({ ...form(), publish: true });
    expect(response.status).toBe(500);
    expect(response.body.message).toBe("An unexpected error occurred");
    expect(await EventModel.countDocuments()).toBe(0);
    expect(await TicketTypeModel.countDocuments()).toBe(0);
  });
  it("requires an active full staff session with manage_events on every admin event route", async () => {
    const { event } = await create(false);
    const paths = [
      ["get", "/events"],
      ["get", `/events/${event.id}`],
      ["post", "/events"],
      ["put", `/events/${event.id}`],
      ["post", `/events/${event.id}/close-sales`],
      ["post", `/events/${event.id}/cancel`],
      ["post", "/uploads/cover"],
    ] as const;
    for (const role of [AdminRole.ADVERTISER, AdminRole.CHECKIN_STAFF]) {
      const actor = await AdminModel.create({
        fullName: "Limited staff",
        email: `${randomBytes(8).toString("hex")}@example.com`,
        passwordHash: randomBytes(32).toString("hex"),
        role,
        twoStepEnabled: true,
      });
      for (const [method, path] of paths)
        expect(
          (
            await request(app)
              [method](`/api/admin${path}`)
              .set("Cookie", cookie(actor))
              .send({})
          ).status,
        ).toBe(403);
    }
    expect((await request(app).get("/api/admin/events")).status).toBe(401);
    const setupActor = await AdminModel.create({
      fullName: "Setup-only staff",
      email: `${randomBytes(8).toString("hex")}@example.com`,
      passwordHash: randomBytes(32).toString("hex"),
      role: AdminRole.ADMIN,
      twoStepEnabled: false,
    });
    expect(
      (
        await request(app)
          .get("/api/admin/events")
          .set("Cookie", cookie(setupActor, "setup"))
      ).body.code,
    ).toBe("two_step_required");
    await AdminModel.updateOne({ _id: owner._id }, { role: AdminRole.ADMIN });
    expect((await post({ title: "Admin draft" })).status).toBe(200);
    await AdminModel.updateOne({ _id: owner._id }, { status: "deactivated" });
    expect((await post({ title: "Blocked draft" })).status).toBe(401);
  });
  it("serves identical 404s for drafts and unknown public records, including ticket types", async () => {
    const { event } = await create(false);
    const unknown = await request(app).get("/api/events/no-such-hike");
    for (const path of [
      event.id,
      event.slug,
      `${event.id}/ticket-types`,
      "unknown/ticket-types",
    ]) {
      const response = await request(app).get(`/api/events/${path}`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual(unknown.body);
    }
    expect((await request(app).get("/api/events")).body.total).toBe(0);
  });
  it("matches public filters, cancelled visibility, inclusive UTC bounds, sorting and pagination", async () => {
    const open = (await create(true, { title: "Open walk", capacity: 30 }))
      .event;
    const few = (
      await create(true, {
        title: "Few walk",
        date: day(8),
        capacity: 20,
        ticketTypes: [{ ...form().ticketTypes[0], priceKobo: 0 }],
      })
    ).event;
    await EventModel.updateOne({ _id: few.id }, { ticketsSold: 12 });
    const sold = (await create(true, { title: "Sold walk", date: day(9) }))
      .event;
    await EventModel.updateOne({ _id: sold.id }, { ticketsSold: 20 });
    const past = (await create()).event;
    await EventModel.updateOne(
      { _id: past.id },
      { startsAt: new Date(Date.now() - 86400000), status: "completed" },
    );
    const cancelled = (await create(true, { title: "Cancelled walk" })).event;
    await EventModel.updateOne({ _id: cancelled.id }, { status: "cancelled" });
    await create(false);
    expect(
      (await request(app).get("/api/events?status=open")).body.items
        .map((e: { id: string }) => e.id)
        .sort(),
    ).toEqual([open.id, few.id].sort());
    expect(
      (await request(app).get("/api/events?status=few")).body.items.map(
        (e: { id: string }) => e.id,
      ),
    ).toEqual([few.id]);
    expect(
      (await request(app).get("/api/events?status=sold_out")).body.items.map(
        (e: { id: string }) => e.id,
      ),
    ).toEqual([sold.id]);
    expect(
      (await request(app).get("/api/events?status=past")).body.items.map(
        (e: { id: string }) => e.id,
      ),
    ).toEqual([past.id]);
    const all = (await request(app).get("/api/events?pageSize=2&page=1")).body;
    expect(all).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(
      (await request(app).get("/api/events?sort=latest")).body.items[0].id,
    ).toBe(sold.id);
    expect(
      (await request(app).get("/api/events?q=main%20park")).body.total,
    ).toBe(5);
    expect((await request(app).get("/api/events?q=%5B")).body.total).toBe(0);
    expect(
      (
        await request(app).get(
          `/api/events?from=${encodeURIComponent(open.startsAt)}&to=${encodeURIComponent(open.startsAt)}`,
        )
      ).body.items.some((e: { id: string }) => e.id === open.id),
    ).toBe(true);
    const upcoming = (await request(app).get("/api/events?upcoming=true")).body;
    expect(Array.isArray(upcoming)).toBe(true);
    expect(upcoming).toHaveLength(3);
    expect((await request(app).get("/api/events?page=1.2")).status).toBe(400);
  });
  it("counts admin tabs before status/search filtering and paginates nine rows", async () => {
    for (let index = 0; index < 11; index++)
      await post({ title: `Draft hike ${index}` });
    const response = await request(app)
      .get("/api/admin/events?status=draft&range=all&page=2")
      .set("Cookie", cookie());
    expect(response.body).toMatchObject({
      total: 11,
      page: 2,
      pageSize: 9,
      counts: { all: 11, draft: 11, published: 0 },
    });
    expect(response.body.items).toHaveLength(2);
    const searched = await request(app)
      .get("/api/admin/events?q=missing&status=published")
      .set("Cookie", cookie());
    expect(searched.body.total).toBe(0);
    expect(searched.body.counts.all).toBe(11);
  });
  it("validates cover type, content and 5 MB limit before the upload service", async () => {
    const route = () =>
      request(app).post("/api/admin/uploads/cover").set("Cookie", cookie());
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    expect((await route().attach("image", png, "cover.png")).body.url).toMatch(
      /^https:/,
    );
    expect(
      (await route().attach("image", Buffer.from("text"), "cover.txt")).body
        .code,
    ).toBe("invalid_file_type");
    expect(
      (
        await route().attach("image", Buffer.from("text"), {
          filename: "cover.jpg",
          contentType: "image/jpeg",
        })
      ).body.code,
    ).toBe("invalid_file_type");
    expect(
      (
        await route().attach(
          "image",
          Buffer.alloc(5 * 1024 * 1024 + 1),
          "cover.png",
        )
      ).status,
    ).toBe(413);
    expect((await route()).status).toBe(400);
    expect(vi.mocked(uploadCover)).toHaveBeenCalledTimes(1);
  });
});
