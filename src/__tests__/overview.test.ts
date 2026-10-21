import { randomBytes } from "crypto";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { runInNewContext } from "vm";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import bootstrap from "../bootstrap";
import { ENV } from "../config/env";
import { limiter } from "../bootstrap/rate-limiting";
import {
  AdminModel,
  AdminRole,
  type AdminDocument,
} from "../database/models/admin.schema";
import { AuditLogModel } from "../database/models/audit-log.schema";
import { EventModel } from "../database/models/events.schema";
import { OrderModel } from "../database/models/orders.schema";
import { TicketModel } from "../database/models/tickets.schema";
import { UserModel } from "../database/models/users.schema";
import { createStaffSession } from "../modules/admin/services/auth-session.service";
import { createSession } from "../modules/users/services/auth-session.service";
import { weekStart } from "../modules/admin/services/overview.service";

const hex = () => randomBytes(12).toString("hex");
let owner: AdminDocument;
let sequence = 0;
const cookie = (actor = owner, scope: "full" | "setup" = "full") =>
  `hip_staff_session=${createStaffSession(actor, scope).token}`;
const read = (actor = owner) =>
  request(app).get("/api/admin/overview").set("Cookie", cookie(actor));
const actor = (role = AdminRole.SUPER_ADMIN) =>
  AdminModel.create({
    fullName: "Overview test staff",
    email: `${hex()}@example.test`,
    passwordHash: hex(),
    role,
    twoStepEnabled: true,
  });
const hiker = (status = "active") =>
  UserModel.create({
    fullName: "Overview test hiker",
    email: `${hex()}@example.test`,
    phone: `+234803${String(++sequence).padStart(7, "0")}`,
    passwordHash: hex(),
    status,
    emailVerified: status !== "unverified",
  });
async function event(status = "published", days = 2) {
  return EventModel.create({
    title: "Overview test hike",
    slug: hex(),
    status,
    startsAt: new Date(Date.now() + days * 86400000),
    scheduleSet: true,
    registrationDeadline: new Date(Date.now() + 86400000),
    capacity: 1000,
  });
}
async function sale(
  eventId: Types.ObjectId,
  at: Date,
  quantity = 1,
  subtotalKobo = 250000,
  status = "paid",
  paymentReview = false,
) {
  const typeId = new Types.ObjectId();
  const order = await OrderModel.create({
    holdId: new Types.ObjectId(),
    eventId,
    ownerHash: hex(),
    requestHash: hex(),
    buyer: {
      fullName: "Overview test buyer",
      email: "overview@example.test",
      phone: "+2348030000000",
    },
    attendees: Array.from({ length: quantity }, () => ({
      ticketTypeId: typeId,
      fullName: "Overview test attendee",
    })),
    emergencyContact: { name: "Emergency contact", phone: "+2348020000000" },
    lines: [
      {
        ticketTypeId: typeId,
        ticketTypeName: "Standard",
        quantity,
        priceKobo: subtotalKobo / quantity,
      },
    ],
    isGuest: true,
    paymentChannel: "card",
    subtotalKobo,
    feeKobo: subtotalKobo ? 10000 : 0,
    amountKobo: subtotalKobo + (subtotalKobo ? 10000 : 0),
    reference: hex(),
    status,
    paidAt: at,
    paymentReview,
    createdAt: new Date(at.getTime() - 86400000),
  });
  if (status === "paid") {
    await TicketModel.create(
      Array.from({ length: quantity }, (_, index) => ({
        code: `HIP-${hex()}`,
        eventId,
        ticketTypeId: typeId,
        orderId: order._id,
        attendeeIndex: index,
        holder: { fullName: "Overview test attendee" },
        ticketTypeName: "Standard",
        pricePaidKobo: subtotalKobo / quantity,
        paymentId: order.reference,
        qrToken: "isolated-test-qr",
        status: "confirmed",
        issuedAt: new Date(),
      })),
    );
    await EventModel.updateOne(
      { _id: eventId },
      { $inc: { ticketsSold: quantity } },
    );
  }
  return order;
}
beforeAll(async () => {
  if (
    !/^hip_auth_test(?:_[a-z0-9]+)?$/.test(
      new URL(ENV.MONGODB_URI).pathname.slice(1),
    )
  )
    throw new Error(
      "Overview tests require an isolated hip_auth_test database.",
    );
  await bootstrap.handleDBConnect();
  await Promise.all([
    AdminModel.init(),
    UserModel.init(),
    OrderModel.init(),
    TicketModel.init(),
    EventModel.init(),
    AuditLogModel.init(),
  ]);
  owner = await actor();
});
beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    OrderModel.deleteMany({}),
    TicketModel.deleteMany({}),
    EventModel.deleteMany({}),
    AuditLogModel.collection.deleteMany({}),
  ]);
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"])
    limiter.resetKey(key);
});
afterAll(async () => {
  if (mongoose.connection.readyState === 1)
    await AdminModel.updateMany(
      {},
      { $set: { status: "deactivated" }, $inc: { sessionVersion: 1 } },
    );
  await mongoose.disconnect();
});

describe("Admin Overview (ANA-001–ANA-004)", () => {
  it("counts completed hiker registrations, never staff, guests or unfinished signups", async () => {
    await Promise.all([
      hiker(),
      hiker("suspended"),
      hiker("deactivated"),
      hiker("unverified"),
    ]);
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.body.registeredHikers).toBe(3);
    expect(response.body.ticketsSold).toEqual({ value: 0, previous: 0 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toHaveProperty("success");
  });

  it("counts issued free/paid tickets and sums each verified order once, excluding holds and failed/pending payments", async () => {
    const hike = await event();
    const start = weekStart(new Date());
    const current = new Date(start.getTime() + 1);
    await sale(hike._id, current, 3, 750000);
    await sale(hike._id, current, 1, 0);
    await sale(hike._id, new Date(start.getTime() - 1), 2, 100000);
    await sale(hike._id, current, 4, 999999, "pending");
    await sale(hike._id, current, 4, 999999, "failed");
    await sale(hike._id, current, 1, 999999, "paid", true);
    await sale(hike._id, new Date(start.getTime() - 604800001), 1, 999999);
    await sale(hike._id, new Date(start.getTime() + 604800000), 1, 999999);
    await EventModel.updateOne({ _id: hike._id }, { seatsHeld: 100 });
    const response = await read();
    expect(response.body.ticketsSold).toEqual({ value: 4, previous: 2 });
    expect(response.body.netRevenueKobo).toEqual({
      value: 750000,
      previous: 100000,
    });
    expect(response.body.attendance).toEqual({
      instances: 0,
      uniqueHikers: 0,
      previousInstances: 0,
    });
    expect(response.body.weekly).toHaveLength(8);
    expect(
      response.body.weekly.every(
        (week: { instances: number; uniqueHikers: number }) =>
          week.instances === 0 && week.uniqueHikers === 0,
      ),
    ).toBe(true);
  });

  it("reports actual zero revenue for free bookings, and uses payment time rather than order creation or hike time", async () => {
    const hike = await event();
    const order = await sale(hike._id, new Date(), 1, 0);
    await OrderModel.collection.updateOne(
      { _id: order._id },
      { $set: { createdAt: new Date(0) } },
    );
    const response = await read();
    expect(response.body.ticketsSold.value).toBe(1);
    expect(response.body.netRevenueKobo.value).toBe(0);
    expect(response.body.attendance.instances).toBe(0);
  });

  it("uses Lagos midnight boundaries, including Sunday UTC and the ISO week year rollover", () => {
    expect(weekStart(new Date("2026-10-18T22:59:59.999Z")).toISOString()).toBe(
      "2026-10-11T23:00:00.000Z",
    );
    expect(weekStart(new Date("2026-10-18T23:00:00.000Z")).toISOString()).toBe(
      "2026-10-18T23:00:00.000Z",
    );
    expect(
      weekStart(new Date("2027-01-03T23:00:00.000Z"), 1).toISOString(),
    ).toBe("2026-12-27T23:00:00.000Z");
  });

  it("returns real bounded activity/upcoming rows with the same revenue as the event list; hides staff audit details from admins", async () => {
    const hike = await event();
    await sale(hike._id, new Date(), 3, 750000);
    await Promise.all([
      event("cancelled", 1),
      event("completed", 1),
      event("published", -1),
    ]);
    await AuditLogModel.create([
      {
        actor: { id: owner.id, name: "Overview manager", role: "super_admin" },
        action: "staff.role_changed",
        target: { type: "staff", id: hex() },
        details: "Private staff change",
        createdAt: new Date(),
      },
      {
        actor: { id: "system", name: "HIP", role: "system" },
        action: "order.paid",
        target: { type: "checkout", id: hex() },
        details: "Issued three tickets",
        createdAt: new Date(Date.now() - 1000),
      },
    ]);
    const response = await read();
    expect(response.body.upcoming).toHaveLength(1);
    expect(response.body.upcoming[0]).toMatchObject({
      confirmed: 3,
      revenueKobo: 750000,
    });
    expect(
      response.body.activity.map((row: { details: string }) => row.details),
    ).toEqual(["Private staff change", "Issued three tickets"]);
    const admin = await actor(AdminRole.ADMIN);
    expect(
      (await read(admin)).body.activity.map(
        (row: { details: string }) => row.details,
      ),
    ).toEqual(["Issued three tickets"]);
    const rows = await request(app)
      .get("/api/admin/events")
      .set("Cookie", cookie());
    expect(
      rows.body.items.find(
        (row: { event: { id: string } }) => row.event.id === hike.id,
      ).revenueKobo,
    ).toBe(750000);
    expect(JSON.stringify(response.body)).not.toMatch(
      /passwordHash|authenticatorSecret|ownerHash|requestHash|qrToken|accessCode|buyer/,
    );
  });

  it("rejects hiker sessions and immediately rejects deactivated staff", async () => {
    const user = await hiker();
    expect(
      (
        await request(app)
          .get("/api/admin/overview")
          .set("Cookie", `hip_session=${createSession(user).token}`)
      ).status,
    ).toBe(401);
    const admin = await actor(AdminRole.ADMIN);
    const session = cookie(admin);
    await AdminModel.updateOne({ _id: admin._id }, { status: "deactivated" });
    expect(
      (await request(app).get("/api/admin/overview").set("Cookie", session))
        .status,
    ).toBe(401);
  });

  it("filters/pages/exports real audit history with readable labels, historical actors, reasons and literal search", async () => {
    const hike = await event();
    const entries = Array.from({ length: 14 }, (_, index) => ({
      actor: { id: owner.id, name: "Historical manager", role: "super_admin" },
      action: "event.updated",
      target: { type: "event", id: hike.id },
      details: `Literal [trail] change ${index}`,
      createdAt: new Date(Date.now() - index * 1000),
    }));
    await AuditLogModel.create(entries);
    await AuditLogModel.create([
      {
        actor: { id: "guest", name: "Guest checkout", role: "guest" },
        action: "order.paid",
        target: { type: "checkout", id: "archived-order" },
        details: "Issued a paid ticket",
        createdAt: new Date(),
      },
      {
        actor: { id: "guest", name: "Guest checkout", role: "guest" },
        action: "payment.verification_failed",
        target: { type: "checkout", id: "archived-order" },
        details: "Payment verification failed",
        reason: "Wrong amount",
        createdAt: new Date(),
      },
    ]);
    const get = (query = {}) =>
      request(app)
        .get("/api/admin/audit-log")
        .query(query)
        .set("Cookie", cookie());
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 16, page: 1, pageSize: 12 });
    expect(first.body.items).toHaveLength(12);
    const second = await get({ page: 2 });
    expect(second.body.items).toHaveLength(4);
    expect(
      new Set([...first.body.items, ...second.body.items].map((row) => row.id))
        .size,
    ).toBe(16);
    const filtered = await get({
      action: "group:events",
      q: hike.title,
      actorId: owner.id,
      all: true,
    });
    expect(filtered.body).toMatchObject({ total: 14, page: 1, pageSize: 14 });
    expect(
      filtered.body.items.every(
        (row: { recordLabel: string }) => row.recordLabel === hike.title,
      ),
    ).toBe(true);
    expect(
      filtered.body.actors.map((row: { id: string }) => row.id).sort(),
    ).toEqual(["guest", owner.id].sort());
    expect((await get({ q: ".*" })).body.total).toBe(0);
    expect((await get({ q: "[trail]" })).body.total).toBe(14);
    const payments = await get({ action: "group:payments", q: "Wrong amount" });
    expect(payments.body.total).toBe(1);
    expect(payments.body.items[0]).toMatchObject({
      reason: "Wrong amount",
      recordLabel: "archived-order",
    });
    expect((await get({ q: "Payment confirmed" })).body.items[0].action).toBe(
      "order.paid",
    );
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(filtered.body)).not.toMatch(
      /passwordHash|authenticatorSecret|tokenHash|ownerHash|qrToken/,
    );
  });

  it("uses inclusive Lagos audit dates and rejects invalid filters without creating edit/delete endpoints", async () => {
    for (const timestamp of [
      "2026-10-18T22:59:59.999Z",
      "2026-10-18T23:00:00.000Z",
      "2026-10-19T22:59:59.999Z",
      "2026-10-19T23:00:00.000Z",
    ]) {
      await AuditLogModel.create({
        actor: { id: owner.id, name: "Manager", role: "super_admin" },
        action: "event.created",
        target: { type: "event", id: "archived-event" },
        details: "Created a draft",
        createdAt: new Date(timestamp),
      });
    }
    const filtered = await request(app)
      .get("/api/admin/audit-log")
      .query({ from: "2026-10-19", to: "2026-10-19" })
      .set("Cookie", cookie());
    expect(filtered.body.total).toBe(2);
    for (const query of [
      { page: 0 },
      { from: "2026-02-30" },
      { from: "2026-10-20", to: "2026-10-19" },
      { action: "group:unknown" },
      { all: "yes" },
      { actorId: { $ne: "" } },
    ]) {
      const response = await request(app)
        .get("/api/admin/audit-log")
        .query(query)
        .set("Cookie", cookie());
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("validation_error");
    }
    const entry = await AuditLogModel.findOne();
    await expect(
      AuditLogModel.updateOne({ _id: entry!._id }, { details: "changed" }),
    ).rejects.toThrow("Audit entries cannot be updated or deleted.");
    for (const method of ["put", "delete"] as const)
      expect(
        (
          await request(app)
            [method]("/api/admin/audit-log")
            .set("Cookie", cookie())
            .send({})
        ).status,
      ).toBe(404);
    expect(await AuditLogModel.countDocuments()).toBe(4);
  });

  it("passes every generated Overview and audit Postman request/assertion against the running HTTP app", async () => {
    const admin = await actor(AdminRole.ADMIN);
    const checkin = await actor(AdminRole.CHECKIN_STAFF);
    const advertiser = await actor(AdminRole.ADVERTISER);
    const setup = await actor();
    setup.twoStepEnabled = false;
    await setup.save();
    const cookies: Record<string, string> = {
      managerCookie: cookie(),
      overviewAdminCookie: cookie(admin),
      overviewCheckinCookie: cookie(checkin),
      overviewAdvertiserCookie: cookie(advertiser),
      overviewSetupCookie: cookie(setup, "setup"),
    };
    const collection = JSON.parse(
      await readFile(
        resolve(
          __dirname,
          "../../postman/HIP-users-auth.postman_collection.json",
        ),
        "utf8",
      ),
    );
    const folders = [
      "Admin — Overview",
      "Admin — Audit log",
      "Admin — Transactions",
    ];
    for (const folderName of folders) {
      const folder = collection.item.find(
        (item: { name: string }) => item.name === folderName,
      );
      expect(folder.item).toHaveLength(
        folderName === "Admin — Overview"
          ? 7
          : folderName === "Admin — Audit log"
            ? 8
            : 12,
      );
      for (const item of folder.item) {
        const call = request(app).get(
          item.request.url
            .replace("{{baseUrl}}", "")
            .replace("{{financeFrom}}", "2000-01-01")
            .replace("{{financeTo}}", "2100-12-31"),
        );
        const header = item.request.header.find(
          (value: { key: string }) => value.key === "Cookie",
        );
        if (header)
          call.set(
            "Cookie",
            header.value.replace(
              /{{(\w+)}}/g,
              (_: string, name: string) => cookies[name],
            ),
          );
        const response = await call;
        const tests = item.event
          .find((entry: { listen: string }) => entry.listen === "test")
          .script.exec.join("\n");
        runInNewContext(tests, {
          pm: {
            response: { code: response.status, json: () => response.body },
            expect,
            test: (_name: string, callback: () => void) => callback(),
            variables: { replaceIn: (value: string) => value },
          },
        });
      }
    }
  });
});

it("reports actual group settlement shares and excludes platform commission", async () => {
  const hike = await event();
  const order = await sale(hike._id, new Date());
  await OrderModel.updateOne(
    { _id: order._id },
    { groupNetKobo: 230000, actualGroupNetKobo: 225000 },
  );
  expect((await read()).body.netRevenueKobo.value).toBe(225000);
});

describe("Financial reporting from checkout orders", () => {
  const today = () =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(
      new Date(),
    );
  const transactions = (query = {}, who = owner) =>
    request(app)
      .get("/api/admin/transactions")
      .query({ from: today(), to: today(), status: "all", ...query })
      .set("Cookie", cookie(who));
  it("includes a verified test sale in revenue while preserving zero bank settlement; all reports agree", async () => {
    const hike = await event();
    const legacy = await sale(hike._id, new Date(), 1, 120000);
    await OrderModel.updateOne(
      { _id: legacy._id },
      { feeKobo: 1800, amountKobo: 121800 },
    );
    const testOrder = await sale(hike._id, new Date(), 1, 120000);
    await OrderModel.updateOne(
      { _id: testOrder._id },
      {
        feeKobo: 1919,
        amountKobo: 127919,
        settlementMode: "test_unsplit",
        settlementDomain: "test",
        groupNetKobo: 120000,
        actualGroupNetKobo: 0,
        actualPlatformNetKobo: 0,
        actualPaystackFeeKobo: 1919,
        feeBreakdown: { platformFeeKobo: 6000, groupNetKobo: 120000 },
      },
    );
    const response = await transactions();
    expect(response.status).toBe(200);
    expect(response.body.summary).toMatchObject({
      grossKobo: 249719,
      ticketSalesKobo: 240000,
      feesKobo: 3719,
      platformFeesKobo: 6000,
      netKobo: 240000,
      testNetKobo: 120000,
    });
    expect(response.body.items).toHaveLength(2);
    expect(
      response.body.items.find((row) => row.reference === testOrder.reference),
    ).toMatchObject({
      paymentMode: "test",
      settlementMode: "test_unsplit",
      netKobo: 120000,
      status: "successful",
    });
    const overview = await read();
    expect(overview.body.netRevenueKobo.value).toBe(240000);
    expect(overview.body.testRevenueKobo.value).toBe(120000);
    const events = await request(app)
      .get("/api/admin/events")
      .set("Cookie", cookie());
    expect(events.body.items[0]).toMatchObject({
      revenueKobo: 240000,
      testRevenueKobo: 120000,
    });
    expect((await OrderModel.findById(testOrder._id))?.actualGroupNetKobo).toBe(
      0,
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toMatch(
      /ownerHash|requestHash|accessCode|qrToken|subaccountCode|deliveryPayload|privateKey/,
    );
  });
  it("lists one payment for multiple tickets and excludes pending, failed and review orders from totals", async () => {
    const hike = await event();
    const paid = await sale(hike._id, new Date(), 3, 600000);
    for (const status of ["pending", "failed"]) {
      const unpaid = await sale(hike._id, new Date(), 1, 900000, status);
      await OrderModel.collection.updateOne(
        { _id: unpaid._id },
        { $set: { createdAt: new Date() } },
      );
    }
    await sale(hike._id, new Date(), 1, 900000, "paid", true);
    await sale(hike._id, new Date(), 1, 0);
    const result = await transactions();
    expect(result.body.total).toBe(5);
    expect(result.body.summary).toMatchObject({
      ticketSalesKobo: 600000,
      netKobo: 600000,
      pendingCount: 1,
      failedCount: 2,
    });
    expect(
      result.body.items.find((row) => row.reference === paid.reference),
    ).toMatchObject({ ticketCount: 3, ticketKobo: 600000 });
    expect(
      result.body.items.find((row) => row.reference === paid.reference)
        .ticketCodes,
    ).toHaveLength(3);
    expect((await transactions({ status: "successful" })).body.total).toBe(2);
    expect((await transactions({ status: "failed" })).body.total).toBe(2);
    expect(
      (await transactions({ status: "refund_requested" })).body.total,
    ).toBe(0);
  });
  it("searches references, ticket IDs, names and events literally; paginates and exports the same totals", async () => {
    const hike = await event();
    for (let i = 0; i < 12; i++) await sale(hike._id, new Date(), 1, 10000);
    const first = await transactions(),
      second = await transactions({ page: 2 }),
      all = await transactions({ all: true });
    expect(first.body.items).toHaveLength(10);
    expect(second.body.items).toHaveLength(2);
    expect(all.body.items).toHaveLength(12);
    expect(all.body.summary).toEqual(first.body.summary);
    expect(
      new Set(
        [...first.body.items, ...second.body.items].map((row) => row.reference),
      ).size,
    ).toBe(12);
    const ref = first.body.items[0].reference;
    expect((await transactions({ q: ref })).body.total).toBe(1);
    expect(
      (await transactions({ q: first.body.items[0].ticketCodes[0] })).body
        .total,
    ).toBe(1);
    expect((await transactions({ q: "Overview test buyer" })).body.total).toBe(
      12,
    );
    expect((await transactions({ q: hike.title })).body.total).toBe(12);
    expect((await transactions({ q: ".*" })).body.total).toBe(0);
    expect((await transactions({ q: "[" })).body.total).toBe(0);
  });
  it("uses Lagos payment dates and explicit previous periods rather than event/order dates", async () => {
    const hike = await event();
    for (const at of [
      "2026-10-18T22:59:59.999Z",
      "2026-10-18T23:00:00.000Z",
      "2026-10-19T22:59:59.999Z",
      "2026-10-19T23:00:00.000Z",
    ])
      await sale(hike._id, new Date(at), 1, 10000);
    const result = await transactions({
      from: "2026-10-19",
      to: "2026-10-19",
      prevFrom: "2026-10-18",
      prevTo: "2026-10-18",
    });
    expect(result.body.total).toBe(2);
    expect(result.body.summary).toMatchObject({
      ticketSalesKobo: 20000,
      previousTicketSalesKobo: 10000,
      netKobo: 20000,
    });
  });
  it("opens a real ticket's whole-order payment without private QR or payment authorization data", async () => {
    const hike = await event();
    const order = await sale(hike._id, new Date(), 2, 400000);
    await TicketModel.updateOne(
      { orderId: order._id, attendeeIndex: 0 },
      { code: "HIP-ABCD-1234" },
    );
    const result = await request(app)
      .get("/api/admin/tickets/hip-abcd-1234")
      .set("Cookie", cookie());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      code: "HIP-ABCD-1234",
      payment: {
        reference: order.reference,
        ticketCount: 2,
        ticketKobo: 400000,
      },
    });
    expect(JSON.stringify(result.body)).not.toMatch(
      /qrToken|ownerHash|requestHash|deliveryPayload|accessCode|authenticator/,
    );
    expect(
      (
        await request(app)
          .get("/api/admin/tickets/HIP-NONE-NONE")
          .set("Cookie", cookie())
      ).status,
    ).toBe(404);
  });
  it("requires a full authorised staff session and rejects invalid filters; never creates refund writes", async () => {
    expect((await request(app).get("/api/admin/transactions")).status).toBe(
      401,
    );
    for (const role of [AdminRole.CHECKIN_STAFF, AdminRole.ADVERTISER]) {
      const who = await actor(role);
      expect((await transactions({}, who)).status).toBe(403);
      expect(
        (
          await request(app)
            .get("/api/admin/tickets/HIP-ABCD-1234")
            .set("Cookie", cookie(who))
        ).status,
      ).toBe(403);
    }
    expect((await transactions({}, await actor(AdminRole.ADMIN))).status).toBe(
      200,
    );
    for (const query of [
      { from: "2026-02-30" },
      { from: "2026-10-20", to: "2026-10-19" },
      { page: 0 },
      { status: "paid" },
      { q: { $ne: "" } },
      { all: "yes" },
      { prevFrom: "2026-01-01" },
    ])
      expect((await transactions(query)).status).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/admin/transactions/reference/refund")
          .set("Cookie", cookie())
          .send({ decision: "approve" })
      ).status,
    ).toBe(404);
  });
});
