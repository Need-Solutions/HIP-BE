import { randomBytes, randomInt } from "crypto";
import bcrypt from "bcrypt";
import mongoose, { Types } from "mongoose";
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
import { UserModel, type UserDocument } from "../database/models/users.schema";
import { EventModel } from "../database/models/events.schema";
import { OrderModel } from "../database/models/orders.schema";
import { SeatHoldModel } from "../database/models/seat-hold.schema";
import { TicketTypeModel } from "../database/models/ticket-types.schema";
import { TicketModel } from "../database/models/tickets.schema";
import { CheckInModel } from "../database/models/check-in.schema";
import { RefundRequestModel } from "../database/models/refund-request.schema";
import { AccountJobModel } from "../database/models/account-job.schema";
import { AuditLogModel } from "../database/models/audit-log.schema";
import { createSession } from "../modules/users/services/auth-session.service";
import { exportLimiter } from "../modules/users/middlewares/export-limit.middleware";
import { initializeAccount } from "../modules/users/services/account-initialize.service";
import { deliverAccountJob } from "../modules/users/services/account-jobs.service";
import { eventEnd } from "../modules/users/services/account-event-time";
import { sendMail } from "../services/mail.service";
import { uploadAvatar, deleteAvatar } from "../services/avatar.service";
import {
  settlementTotals,
  ticketRefundAmounts,
} from "../modules/checkout/services/fees";
import * as audit from "../modules/admin/services/audit-log.service";
import { ticketDetail as adminTicketDetail } from "../modules/admin/services/transactions.service";

vi.mock("../services/mail.service", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/avatar.service", () => ({
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn().mockResolvedValue(undefined),
}));
const password = `${randomBytes(20).toString("hex")}1!`;
let passwordHash: string;
const cookie = (u: UserDocument) => `hip_session=${createSession(u).token}`;
const person = () =>
  UserModel.create({
    fullName: "Account test hiker",
    email: `account-${randomBytes(8).toString("hex")}@example.test`,
    phone: `+234803${randomInt(1000000, 10000000)}`,
    passwordHash,
    status: "active",
    emailVerified: true,
  });
const req = (u: UserDocument, path: string) =>
  request(app).get(`/api/me${path}`).set("Cookie", cookie(u));
const refund = (u: UserDocument, code: string, path = "refund-request") =>
  request(app)
    .post(`/api/me/tickets/${code}/${path}`)
    .set("Cookie", cookie(u))
    .send({ reason: "Unable to attend" });
async function booking(
  user: UserDocument,
  hours = 100,
  price = 10001,
  buyer: UserDocument | null = user,
) {
  const event = await EventModel.create({
    title: "Account trail",
    slug: `account-${randomBytes(8).toString("hex")}`,
    startsAt: new Date(Date.now() + hours * 3600000),
    durationLabel: "3 hours",
    capacity: 10,
    ticketsSold: 1,
    status: "published",
    meetingPoint: "Park gate",
    location: "Abuja trail",
  });
  const type = new Types.ObjectId();
  const fees = settlementTotals([{ priceKobo: price, quantity: 1 }], {
    platformFeePercent: 5,
    platformFeeMode: "added_to_buyer",
    platformFeeOnRefund: "refund",
    paystackFeeBearer: "hiker",
  });
  const order = await OrderModel.create({
    holdId: new Types.ObjectId(),
    eventId: event._id,
    ownerHash: randomBytes(32).toString("hex"),
    requestHash: randomBytes(32).toString("hex"),
    ...(buyer ? { buyerUserId: buyer._id } : {}),
    buyer: { fullName: user.fullName, email: user.email, phone: user.phone },
    attendees: [{ ticketTypeId: type, fullName: user.fullName }],
    lines: [
      {
        ticketTypeId: type,
        ticketTypeName: "Standard",
        quantity: 1,
        priceKobo: price,
      },
    ],
    isGuest: !buyer,
    paymentChannel: "card",
    subtotalKobo: price,
    feeKobo: fees.paystackFeeKobo,
    feeBreakdown: fees,
    amountKobo: fees.totalKobo,
    reference: `HIP-${randomBytes(12).toString("hex")}`,
    status: "paid",
  });
  const ticket = await TicketModel.create({
    code: `HIP-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`,
    eventId: event._id,
    ticketTypeId: type,
    orderId: order._id,
    attendeeIndex: 0,
    holderUserId: user._id,
    holder: { fullName: user.fullName, email: user.email, phone: user.phone },
    ticketTypeName: "Standard",
    pricePaidKobo: price,
    paymentId: order.reference,
    qrToken: "synthetic-signed-QR-fixture",
    status: "confirmed",
  });
  return { event, order, ticket };
}
beforeAll(async () => {
  if (
    !/^hip_auth_test(?:_[a-z0-9]+)?$/.test(
      new URL(ENV.MONGODB_URI).pathname.slice(1),
    )
  )
    throw new Error("Account tests require a dedicated test database.");
  await bootstrap.handleDBConnect();
  await initializeAccount();
  passwordHash = await bcrypt.hash(password, 10);
});
afterAll(async () => {
  await UserModel.updateMany(
    { status: "active" },
    { $set: { status: "deactivated" } },
  );
  await mongoose.disconnect();
});
beforeEach(async () => {
  for (const model of [
    UserModel,
    EventModel,
    OrderModel,
    SeatHoldModel,
    TicketTypeModel,
    TicketModel,
    CheckInModel,
    RefundRequestModel,
    AccountJobModel,
  ])
    await model.collection.deleteMany({});
  await AuditLogModel.collection.deleteMany({});
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    limiter.resetKey(ip);
  vi.restoreAllMocks();
  vi.mocked(sendMail).mockReset().mockResolvedValue(undefined);
  vi.mocked(uploadAvatar).mockReset().mockResolvedValue({
    url: "https://res.cloudinary.com/test/image/upload/avatar.png",
    publicId: "hip/avatars/new",
  });
  vi.mocked(deleteAvatar).mockReset().mockResolvedValue(undefined);
});

describe("Account authorization", () => {
  it.each([
    ["get", "/tickets"],
    ["get", "/tickets/HIP-AAAA-BBBB"],
    ["post", "/tickets/HIP-AAAA-BBBB/refund-request"],
    ["get", "/refund-quote/HIP-AAAA-BBBB"],
    ["get", "/history"],
    ["post", "/photo"],
    ["delete", "/photo"],
    ["get", "/export"],
    ["delete", ""],
  ] as const)("requires a hiker cookie for %s %s", async (method, path) => {
    expect((await request(app)[method](`/api/me${path}`).send({})).status).toBe(
      401,
    );
  });
  it("does not let an unrelated user view, quote or refund a ticket", async () => {
    const owner = await person(),
      stranger = await person();
    const { ticket } = await booking(owner);
    for (const response of [
      await req(stranger, `/tickets/${ticket.code}`),
      await req(stranger, `/refund-quote/${ticket.code}`),
      await refund(stranger, ticket.code),
    ])
      expect(response.status).toBe(404);
  });
});
describe("Refund policy", () => {
  it.each([
    [72, 100],
    [71 + 59 / 60, 50],
    [2.01, 50],
  ] as const)("quotes %s hours as %s percent", async (hours, percent) => {
    const user = await person();
    const { ticket, event } = await booking(user, hours);
    const now = event.startsAt!.getTime() - hours * 3600000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    const response = await req(user, `/refund-quote/${ticket.code}`);
    spy.mockRestore();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      eligible: true,
      percent,
      amount: percent === 100 ? 10501 : 5251,
      platformFeeRefunded: percent === 100 ? 500 : 250,
    });
    expect(await RefundRequestModel.countDocuments()).toBe(0);
  });
  it.each([
    "checkin_open",
    "explicit_open",
    "checked_in",
    "recorded_checkin",
    "free",
    "duplicate",
    "ended",
    "cancelled",
  ])("refuses %s", async (rule) => {
    const user = await person();
    const { ticket, event } = await booking(
      user,
      rule === "checkin_open" ? 2 : 100,
      rule === "free" ? 0 : 10001,
    );
    if (rule === "explicit_open")
      await EventModel.updateOne(
        { _id: event.id },
        { checkInOpensAt: new Date(Date.now() - 1000) },
      );
    if (rule === "checked_in")
      await TicketModel.updateOne({ _id: ticket.id }, { status: "checked_in" });
    if (rule === "recorded_checkin")
      await CheckInModel.create({
        ticket: ticket._id,
        event: event._id,
        user: user._id,
        checkedInAt: new Date(),
        method: "manual",
      });
    if (rule === "ended" || rule === "cancelled")
      await EventModel.updateOne(
        { _id: event.id },
        { status: rule === "ended" ? "completed" : "cancelled" },
      );
    if (rule === "duplicate")
      expect((await refund(user, ticket.code)).status).toBe(200);
    const response = await refund(user, ticket.code);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("REFUND_NOT_ALLOWED");
    expect(
      (await req(user, `/refund-quote/${ticket.code}`)).body.eligible,
    ).toBe(false);
  });
  it("requests exactly once under concurrency, locks the QR, audits, emails and retains capacity", async () => {
    const user = await person();
    const { ticket, event } = await booking(user);
    const responses = await Promise.all([
      refund(user, ticket.code),
      refund(user, ticket.code),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await RefundRequestModel.countDocuments()).toBe(1);
    expect((await TicketModel.findById(ticket.id))?.status).toBe(
      "refund_pending",
    );
    expect((await adminTicketDetail(ticket.code)).status).toBe(
      "refund_requested",
    );
    expect((await EventModel.findById(event.id))?.ticketsSold).toBe(1);
    expect(
      await AuditLogModel.countDocuments({ action: "refund.requested" }),
    ).toBe(1);
    expect(vi.mocked(sendMail).mock.calls[0][0].subject).toBe(
      "Refund request received",
    );
    expect((await req(user, `/tickets/${ticket.code}`)).body.qrToken).toBe("");
    expect((await req(user, "/tickets")).body.tickets[0].refund.status).toBe(
      "requested",
    );
  });
  it("keeps the frontend /refund alias and rejects holder-only refund requests", async () => {
    const holder = await person(),
      buyer = await person();
    const { ticket } = await booking(holder, 100, 10001, buyer);
    expect((await refund(holder, ticket.code)).status).toBe(409);
    expect((await refund(buyer, ticket.code, "refund")).body.status).toBe(
      "requested",
    );
  });
  it("rolls back the request and QR lock when its audit write fails", async () => {
    const user = await person();
    const { ticket } = await booking(user);
    vi.spyOn(audit, "appendAudit").mockRejectedValue(
      new Error("Synthetic audit failure"),
    );
    expect((await refund(user, ticket.code)).status).toBe(500);
    expect(await RefundRequestModel.countDocuments()).toBe(0);
    expect((await TicketModel.findById(ticket.id))?.status).toBe("confirmed");
    expect(sendMail).not.toHaveBeenCalled();
  });
  it.each(["added_to_buyer", "deducted_from_group"] as const)(
    "uses frozen %s fees with half-up rounding and refund/keep",
    (mode) => {
      for (const policy of ["refund", "keep"] as const) {
        const frozen = settlementTotals([{ priceKobo: 10001, quantity: 1 }], {
          platformFeePercent: 5,
          platformFeeMode: mode,
          platformFeeOnRefund: policy,
          paystackFeeBearer: "hiker",
        });
        const result = ticketRefundAmounts(10001, 50, frozen);
        expect(result.platformFeeRefundedKobo).toBe(
          policy === "refund" ? 250 : 0,
        );
        expect(result.totalRefundKobo).toBe(
          5001 +
            (policy === "refund" ? 250 : 0) -
            (mode === "deducted_from_group" ? 250 : 0),
        );
        expect(result.paystackFeeRefundedKobo).toBe(0);
      }
    },
  );
  it("retains a committed request when email is unavailable and retries its encrypted outbox", async () => {
    const user = await person();
    const { ticket } = await booking(user);
    vi.mocked(sendMail).mockRejectedValueOnce(
      new Error("Synthetic mail outage"),
    );
    expect((await refund(user, ticket.code)).status).toBe(200);
    const job = await AccountJobModel.findOne({ state: "pending" }).select(
      "+payload",
    );
    expect(job?.payload.includes(user.email)).toBe(false);
    await AccountJobModel.updateOne({ _id: job!.id }, { retryAt: new Date(0) });
    await deliverAccountJob(job!.id);
    expect(
      (await AccountJobModel.findById(job!.id).select("+payload"))?.payload,
    ).toBeUndefined();
  });
});
describe("Account lists and attendance", () => {
  it("counts unpaid orders separately on every tab, excluding expired holds", async () => {
    const user = await person();
    const { event, order, ticket } = await booking(user);
    await TicketModel.deleteOne({ _id: ticket.id });
    await OrderModel.updateOne({ _id: order.id }, { status: "pending" });
    await EventModel.updateOne(
      { _id: event.id },
      { seatsHeld: 1, ticketsSold: 0 },
    );
    await TicketTypeModel.create({
      _id: ticket.ticketTypeId,
      eventId: event.id,
      name: "Standard",
      priceKobo: ticket.pricePaidKobo,
      quantityLimit: 10,
      quantityHeld: 1,
      salesStart: new Date(0),
      salesEnd: event.startsAt,
    });
    const hold = await SeatHoldModel.create({
      _id: order.holdId,
      eventId: event.id,
      ownerHash: randomBytes(32).toString("hex"),
      buyerUserId: user.id,
      items: [{ ticketTypeId: ticket.ticketTypeId, quantity: 1 }],
      quantity: 1,
      expiresAt: new Date(Date.now() + 600000),
      state: "active",
    });
    for (const tab of ["upcoming", "past", "cancelled"]) {
      const response = await req(user, `/tickets?tab=${tab}`);
      expect(response.body.counts).toEqual({
        upcoming: 0,
        upcomingBoughtForOthers: 0,
        past: 0,
        cancelled: 0,
        pending: 1,
      });
      expect(response.body.pending).toHaveLength(tab === "upcoming" ? 1 : 0);
    }
    await SeatHoldModel.updateOne({ _id: hold.id }, { expiresAt: new Date(0) });
    const expired = await req(user, "/tickets");
    expect(expired.status).toBe(200);
    expect(expired.body.counts.pending).toBe(0);
  });
  it("tabs include held, bought-for-others and merged guest tickets with stable pagination", async () => {
    const user = await person(),
      other = await person();
    const own = await booking(user),
      bought = await booking(other, 110, 10001, user),
      guest = await booking(user, 120, 10001, null);
    await TicketModel.updateOne(
      { _id: guest.ticket.id },
      { $unset: { holderUserId: 1 } },
    );
    const past = await booking(user, -10),
      cancelled = await booking(user, 100);
    await EventModel.updateOne(
      { _id: cancelled.event.id },
      { status: "cancelled" },
    );
    const upcoming = await req(user, "/tickets?tab=upcoming&pageSize=2");
    expect(upcoming.status).toBe(200);
    expect(upcoming.body).toMatchObject({
      total: 3,
      page: 1,
      pageSize: 2,
      counts: {
        upcoming: 2,
        upcomingBoughtForOthers: 1,
        past: 1,
        cancelled: 1,
        pending: 0,
      },
    });
    expect(upcoming.body.tickets.map((t: { code: string }) => t.code)).toEqual([
      own.ticket.code,
      bought.ticket.code,
    ]);
    const second = await req(user, "/tickets?tab=upcoming&page=2&pageSize=2");
    expect(second.body.tickets[0]).toMatchObject({
      code: guest.ticket.code,
      heldByMe: true,
      boughtByMe: true,
    });
    expect(upcoming.body.tickets[1]).toMatchObject({
      heldByMe: false,
      boughtByMe: true,
    });
    for (const listed of [...upcoming.body.tickets, ...second.body.tickets]) {
      const detail = await req(user, `/tickets/${listed.code}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toEqual(listed);
    }
    expect((await req(user, "/tickets?tab=past")).body.tickets[0].code).toBe(
      past.ticket.code,
    );
    expect(
      (await req(user, "/tickets?tab=cancelled")).body.tickets[0].code,
    ).toBe(cancelled.ticket.code);
  });
  it("counts only recorded check-ins; exposes missed/refunded and optional totals", async () => {
    const user = await person(),
      other = await person();
    const attended = await booking(user, -10),
      missed = await booking(user, -11),
      returned = await booking(user, -12),
      otherPerson = await booking(other, -13, 10001, user);
    await EventModel.updateOne(
      { _id: missed.event.id },
      { attendanceClosedAt: new Date() },
    );
    await booking(user, 100);
    await TicketModel.updateOne(
      { _id: returned.ticket.id },
      { status: "refunded" },
    );
    await CheckInModel.create({
      ticket: attended.ticket._id,
      event: attended.event._id,
      user: user._id,
      checkedInAt: attended.event.startsAt,
      method: "qr_offline",
    });
    const response = await req(user, "/history?includeTotals=true");
    expect(response.body.totals).toMatchObject({
      hikesAttended: 1,
      uniqueTrails: 1,
      mostRecentHike: { ticketCode: attended.ticket.code },
    });
    expect(
      response.body.entries.map((e: { outcome: string }) => e.outcome).sort(),
    ).toEqual(["attended", "missed", "refunded"]);
    expect(
      response.body.entries.find(
        (e: { ticketCode: string }) => e.ticketCode === missed.ticket.code,
      ).outcome,
    ).toBe("missed");
    expect(JSON.stringify(response.body)).not.toContain(
      otherPerson.ticket.code,
    );
    expect(Array.isArray((await req(user, "/history")).body)).toBe(true);
    expect((await req(user, "/profile")).body.hikesAttended).toBe(1);
  });
  it("has empty history/totals with no attendance and never infers it from sales", async () => {
    const user = await person();
    await booking(user);
    await booking(user, -100);
    const response = await req(user, "/history?includeTotals=true");
    expect(response.body).toEqual({
      entries: [],
      totals: { hikesAttended: 0, uniqueTrails: 0, mostRecentHike: null },
    });
  });
  it("omits ended and completed unadmitted hikes until attendance closes", async () => {
    const user = await person();
    const { event, ticket } = await booking(user, -100);
    await EventModel.updateOne({ _id: event.id }, { status: "completed" });
    expect((await req(user, "/history")).body).toEqual([]);
    await EventModel.updateOne(
      { _id: event.id },
      { attendanceClosedAt: new Date() },
    );
    expect((await req(user, "/history")).body).toMatchObject([
      { ticketCode: ticket.code, outcome: "missed" },
    ]);
  });
  it("returns recorded check-in and refund information in both ticket representations", async () => {
    const user = await person();
    const { event, ticket } = await booking(user);
    await CheckInModel.create({
      ticket: ticket.id,
      event: event.id,
      user: user.id,
      checkedInAt: new Date(),
      method: "qr",
    });
    const list = await req(user, "/tickets");
    const detail = await req(user, `/tickets/${ticket.code}`);
    expect(detail.body).toEqual(list.body.tickets[0]);
    expect(detail.body.checkIn.method).toBe("qr");
    await CheckInModel.deleteMany({ ticket: ticket.id });
    expect((await refund(user, ticket.code)).status).toBe(200);
    const requested = await req(user, `/tickets/${ticket.code}`);
    expect(requested.body).toEqual(
      (await req(user, "/tickets")).body.tickets[0],
    );
    expect(requested.body.qrToken).toBe("");
    expect(requested.body.refund.status).toBe("requested");
  });
  it("uses explicit ends and parses legacy duration labels including days/ranges", async () => {
    const user = await person();
    const { event } = await booking(user, 1);
    expect(
      eventEnd({ ...event.toObject(), durationLabel: "About 2 days 3 hours" }),
    ).toBe(event.startsAt!.getTime() + 51 * 3600000);
    expect(eventEnd({ ...event.toObject(), durationLabel: "3–4 hrs" })).toBe(
      event.startsAt!.getTime() + 4 * 3600000,
    );
    expect(eventEnd({ ...event.toObject(), endsAt: new Date(1000) })).toBe(
      1000,
    );
  });
});
describe("Photos, export and deletion", () => {
  it.each([
    ["bad.txt", "text/plain", Buffer.from("text"), 400],
    ["fake.png", "image/png", Buffer.from("not PNG"), 400],
    ["large.png", "image/png", Buffer.alloc(5 * 1024 * 1024 + 1), 413],
  ] as const)(
    "rejects %s before Cloudinary",
    async (name, type, bytes, status) => {
      const user = await person();
      const response = await request(app)
        .post("/api/me/photo")
        .set("Cookie", cookie(user))
        .attach("image", bytes, { filename: name, contentType: type });
      expect(response.status).toBe(status);
      expect(uploadAvatar).not.toHaveBeenCalled();
    },
  );
  it("replaces/deletes photos and removes the old asset", async () => {
    const user = await person();
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", cookie(user))).body
        .photoUrl,
    ).toBeNull();
    await UserModel.updateOne(
      { _id: user.id },
      {
        photoUrl: "https://example.test/old.png",
        photoPublicId: "hip/avatars/old",
      },
    );
    const response = await request(app)
      .post("/api/me/photo")
      .set("Cookie", cookie(user))
      .attach("image", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), {
        filename: "avatar.png",
        contentType: "image/png",
      });
    expect(response.status).toBe(200);
    expect(response.body.photoUrl).toBe(
      "https://res.cloudinary.com/test/image/upload/avatar.png",
    );
    expect(response.body.photoPublicId).toBeUndefined();
    const session = await request(app)
      .get("/api/auth/me")
      .set("Cookie", cookie(user));
    expect(session.body.photoUrl).toBe(response.body.photoUrl);
    expect(session.body.photoPublicId).toBeUndefined();
    const login = await request(app)
      .post("/api/auth/user-login")
      .send({ identifier: user.email, password });
    expect(login.body.photoUrl).toBe(response.body.photoUrl);
    expect(deleteAvatar).toHaveBeenCalledWith("hip/avatars/old");
    const removed = await request(app)
      .delete("/api/me/photo")
      .set("Cookie", cookie(user));
    expect(removed.status).toBe(200);
    expect(removed.body.photoUrl).toBeUndefined();
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", cookie(user))).body
        .photoUrl,
    ).toBeNull();
    expect(deleteAvatar).toHaveBeenCalledWith("hip/avatars/new");
  });
  it("exports only allowlisted data and limits each hiker to three exports per hour", async () => {
    const user = await person();
    const ownBooking = await booking(user);
    expect((await refund(user, ownBooking.ticket.code)).status).toBe(200);
    const other = await person();
    const otherBooking = await booking(other);
    exportLimiter.resetKey(user.id);
    for (let n = 0; n < 3; n++) {
      const response = await req(user, "/export");
      expect(response.status).toBe(200);
      expect(response.headers["content-disposition"]).toContain("attachment");
      for (const key of [
        "passwordHash",
        "sessionVersion",
        "qrToken",
        "ownerHash",
        "accessCode",
        "deliveryPayload",
        "tokenHash",
        "_id",
        "photoPublicId",
      ])
        expect(response.text).not.toContain(`"${key}"`);
      expect(response.text).not.toContain(otherBooking.ticket.code);
      expect(response.body.payments).toHaveLength(1);
      expect(response.body.refundRequests).toHaveLength(1);
      expect(response.body.refundRequests[0].feeBreakdown.totalRefundKobo).toBe(
        10501,
      );
    }
    expect((await req(user, "/export")).status).toBe(429);
    expect((await req(other, "/export")).status).toBe(200);
  });
  it.each(["confirmed", "refund_pending", "checked_in"] as const)(
    "blocks deletion with an upcoming %s ticket",
    async (status) => {
      const user = await person();
      const { ticket } = await booking(user);
      await TicketModel.updateOne({ _id: ticket.id }, { status });
      const response = await request(app)
        .delete("/api/me")
        .set("Cookie", cookie(user))
        .send({ password, confirm: "DELETE" });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("ACCOUNT_HAS_UPCOMING_TICKETS");
      expect((await UserModel.findById(user.id))?.status).toBe("active");
    },
  );
  it("anonymises transactionally, retains financial/attendance records, revokes sessions and frees contact uniqueness", async () => {
    const user = await person();
    const savedCookie = cookie(user);
    const { ticket, event, order } = await booking(user, -10);
    await CheckInModel.create({
      ticket: ticket._id,
      event: event._id,
      user: user._id,
      checkedInAt: event.startsAt,
      method: "manual",
    });
    await UserModel.updateOne(
      { _id: user.id },
      {
        photoUrl: "https://example.test/old.png",
        photoPublicId: "hip/avatars/old",
      },
    );
    const response = await request(app)
      .delete("/api/me")
      .set("Cookie", savedCookie)
      .send({ password, confirm: "DELETE" });
    expect(response.status).toBe(204);
    expect(response.headers["set-cookie"][0]).toContain("hip_session=;");
    const deleted = await UserModel.findById(user.id).select(
      "+passwordHash +photoPublicId",
    );
    expect(deleted).toMatchObject({
      fullName: "Deleted hiker",
      status: "deleted",
      emailVerified: false,
      phoneVerified: false,
    });
    for (const key of [
      "email",
      "phone",
      "passwordHash",
      "photoUrl",
      "photoPublicId",
    ])
      expect(deleted?.get(key)).toBeUndefined();
    expect(await TicketModel.exists({ _id: ticket.id })).toBeTruthy();
    expect(await OrderModel.exists({ _id: order.id })).toBeTruthy();
    expect(await CheckInModel.exists({ ticket: ticket._id })).toBeTruthy();
    expect(
      (await request(app).get("/api/me/tickets").set("Cookie", savedCookie))
        .status,
    ).toBe(401);
    expect(
      await AuditLogModel.countDocuments({ action: "hiker.deleted" }),
    ).toBe(1);
    expect(vi.mocked(sendMail).mock.calls[0][0].to).toBe(user.email);
    expect(deleteAvatar).toHaveBeenCalledWith("hip/avatars/old");
    const second = await person();
    expect(
      (
        await request(app)
          .delete("/api/me")
          .set("Cookie", cookie(second))
          .send({ password, confirm: "DELETE" })
      ).status,
    ).toBe(204);
    await UserModel.create({
      fullName: "Re-registered hiker",
      email: user.email,
      phone: user.phone,
      passwordHash,
      status: "active",
    });
  });
  it("requires the password and exact DELETE confirmation", async () => {
    const user = await person();
    expect(
      (
        await request(app)
          .delete("/api/me")
          .set("Cookie", cookie(user))
          .send({ password, confirm: "delete" })
      ).status,
    ).toBe(400);
    const wrong = await request(app)
      .delete("/api/me")
      .set("Cookie", cookie(user))
      .send({ password: randomBytes(20).toString("hex"), confirm: "DELETE" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.field).toBe("password");
  });
  it("rolls back anonymisation and its queued email if the audit fails", async () => {
    const user = await person();
    vi.spyOn(audit, "appendAudit").mockRejectedValue(
      new Error("Synthetic audit failure"),
    );
    expect(
      (
        await request(app)
          .delete("/api/me")
          .set("Cookie", cookie(user))
          .send({ password, confirm: "DELETE" })
      ).status,
    ).toBe(500);
    expect((await UserModel.findById(user.id))?.status).toBe("active");
    expect(await AccountJobModel.countDocuments()).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
