import { createHmac, randomBytes, randomInt } from "crypto";
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
import { EventModel } from "../database/models/events.schema";
import { TicketTypeModel } from "../database/models/ticket-types.schema";
import { SeatHoldModel } from "../database/models/seat-hold.schema";
import { OrderModel } from "../database/models/orders.schema";
import { TicketModel } from "../database/models/tickets.schema";
import { UserModel } from "../database/models/users.schema";
import { GuestTicketLinkModel } from "../database/models/guest-ticket-link.schema";
import { EventSigningKeyModel } from "../database/models/event-signing-key.schema";
import { CheckoutSettingsModel } from "../database/models/checkout-settings.schema";
import { AdminModel, AdminRole } from "../database/models/admin.schema";
import { createStaffSession } from "../modules/admin/services/auth-session.service";
import { AuditLogModel } from "../database/models/audit-log.schema";
import { VerificationCodeModel } from "../database/models/verification-code.schema";
import { initializeCheckout } from "../modules/checkout/services/checkout-maintenance.service";
import { retryTicketMail } from "../modules/checkout/services/checkout-mail.service";
import { expireHolds } from "../modules/checkout/services/seat-hold.service";
import { adminDetail } from "../modules/events/services/event-query.service";
import { createSession } from "../modules/users/services/auth-session.service";
import { hashCode } from "../modules/users/services/verification-code.service";
import { sendMail } from "../services/mail.service";
import {
  initializePayment,
  verifyPayment,
  paystackDomain,
  resolveSettlementAccount,
  createSettlementSubaccount,
  type PaymentVerification,
} from "../services/paystack.service";
import { AppError } from "../shared/errors/app.error";
import * as audit from "../modules/admin/services/audit-log.service";
import { verifyTicketQr } from "../../../hip-frontend/src/lib/ticketQr";
import { paystackFeeKobo as frontendFee } from "../../../hip-frontend/src/lib/fees";
import { paystackFeeKobo } from "../modules/checkout/services/fees";

vi.mock("../services/mail.service", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/paystack.service", () => ({
  requirePaystack: vi.fn(),
  paystackDomain: vi.fn(() => "test"),
  resolveSettlementAccount: vi.fn(),
  createSettlementSubaccount: vi.fn(),
  initializePayment: vi.fn(),
  verifyPayment: vi.fn(),
}));
const mail = vi.mocked(sendMail);
let providerStatus: PaymentVerification["status"],
  providerPatch: Partial<PaymentVerification>;
const buyer = () => ({
  fullName: "Checkout buyer",
  email: `buyer-${randomBytes(6).toString("hex")}@example.com`,
  phone: `+234803${randomInt(1000000, 10000000)}`,
});
async function fixture(priceKobo = 250000, capacity = 20) {
  const event = await EventModel.create({
    title: "Checkout trail",
    slug: `checkout-${randomBytes(8).toString("hex")}`,
    description: "A guided hike for checkout verification.",
    startsAt: new Date(Date.now() + 7 * 86400000),
    registrationDeadline: new Date(Date.now() + 6 * 86400000),
    scheduleSet: true,
    durationLabel: "3 hours",
    meetingPoint: "Park gate",
    location: "Abuja",
    emergencyInfo: "First aid with guide.",
    capacity,
    status: "published",
  });
  const type = await TicketTypeModel.create({
    eventId: event._id,
    name: "Standard",
    priceKobo,
    quantityLimit: capacity,
    salesStart: new Date(Date.now() - 86400000),
    salesEnd: new Date(Date.now() + 6 * 86400000),
  });
  return { event, type };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const agent = () => request.agent(app);
async function reserve(
  client: ReturnType<typeof agent>,
  f: Fixture,
  quantity = 1,
) {
  const items = [{ ticketTypeId: f.type.id, quantity }];
  const held = await client
    .post("/api/checkout/holds")
    .send({ eventId: f.event.id, items });
  expect(held.status).toBe(200);
  const contact = buyer();
  return {
    hold: held,
    input: {
      holdId: held.body.holdId as string,
      eventId: f.event.id,
      items,
      buyer: contact,
      attendees: Array.from({ length: quantity }, () => ({
        ticketTypeId: f.type.id,
        ...contact,
      })),
      emergencyContact: { name: "Emergency contact", phone: "+2348021112233" },
      createAccount: false,
      whatsappReminders: false,
      paymentChannel: "card",
    },
  };
}
async function started(price = 250000, quantity = 1) {
  const f = await fixture(price),
    client = agent(),
    held = await reserve(client, f, quantity);
  const response = await client.post("/api/checkout").send(held.input);
  expect(response.status).toBe(200);
  return {
    ...f,
    ...held,
    client,
    response,
    id: response.body.checkoutId as string,
  };
}
const poll = (item: Awaited<ReturnType<typeof started>>) =>
  item.client.get(`/api/checkout/${item.id}`);
const webhook = (reference: string, patch = {}) => {
  const raw = ` { "event": "charge.success", "data": ${JSON.stringify({ reference, amount: 1, ...patch })} } `;
  return request(app)
    .post("/api/webhooks/paystack")
    .set("Content-Type", "application/json")
    .set(
      "x-paystack-signature",
      createHmac("sha512", ENV.PAYSTACK_SECRET_KEY!).update(raw).digest("hex"),
    )
    .send(raw);
};

beforeAll(async () => {
  if (
    !/^hip_auth_test(?:_[a-z0-9]+)?$/.test(
      new URL(ENV.MONGODB_URI).pathname.slice(1),
    )
  )
    throw new Error(
      "Checkout tests require an isolated hip_auth_test database.",
    );
  await bootstrap.handleDBConnect();
  if (!(await mongoose.connection.db!.admin().command({ hello: 1 })).setName)
    throw new Error("Checkout tests require a replica set.");
  await initializeCheckout();
  await Promise.all([
    EventModel.init(),
    TicketTypeModel.init(),
    UserModel.init(),
    AuditLogModel.init(),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await AuditLogModel.collection.deleteMany({});
  await Promise.all([
    CheckoutSettingsModel.deleteMany({}),
    AdminModel.deleteMany({}),
    EventModel.deleteMany({}),
    TicketTypeModel.deleteMany({}),
    SeatHoldModel.deleteMany({}),
    OrderModel.deleteMany({}),
    TicketModel.deleteMany({}),
    UserModel.deleteMany({}),
    GuestTicketLinkModel.deleteMany({}),
    EventSigningKeyModel.deleteMany({}),
    VerificationCodeModel.deleteMany({}),
  ]);
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"])
    limiter.resetKey(key);
  await CheckoutSettingsModel.create({
    _id: "checkout",
    platformFeePercent: 5,
    platformFeeMode: "added_to_buyer",
    platformFeeOnRefund: "refund",
    paystackFeeBearer: "hiker",
    subaccountCode: "ACCT_fixture",
    providerDomain: "test",
  });
  vi.mocked(paystackDomain).mockReturnValue("test");
  vi.mocked(createSettlementSubaccount).mockReset();
  providerStatus = "pending";
  providerPatch = {};
  mail.mockReset().mockResolvedValue(undefined);
  vi.mocked(initializePayment)
    .mockReset()
    .mockResolvedValue(`access-${randomBytes(8).toString("hex")}`);
  vi.mocked(verifyPayment)
    .mockReset()
    .mockImplementation(async (reference) => {
      const order = (await OrderModel.findOne({ reference }))!;
      return {
        reference,
        status: providerStatus,
        amount: order.amountKobo,
        currency: "NGN",
        id: `tx-${reference}`,
        paid_at: new Date().toISOString(),
        domain: "test",
        fees: order.feeKobo,
        subaccount: { subaccount_code: order.subaccountCode },
        fees_split:
          order.settlementMode === "test_unsplit"
            ? null
            : {
                paystack: order.feeKobo,
                integration:
                  order.amountKobo - (order.groupNetKobo ?? 0) - order.feeKobo,
                subaccount: order.groupNetKobo,
                params: {
                  bearer: order.settlementBearer,
                  transaction_charge: order.transactionChargeKobo,
                },
              },
        ...providerPatch,
      };
    });
});

describe("Checkout and tickets (TKT-006–TKT-018)", () => {
  it("holds seats for ten minutes, counts them in public availability only, and releases expiry exactly once", async () => {
    const f = await fixture(),
      client = agent();
    const held = await reserve(client, f, 2);
    expect(Date.parse(held.hold.body.expiresAt) - Date.now()).toBeGreaterThan(
      590000,
    );
    expect(held.hold.headers["set-cookie"].join(";")).toMatch(
      /hip_checkout=.*HttpOnly/,
    );
    expect(
      (await request(app).get(`/api/events/${f.event.slug}`)).body.ticketsSold,
    ).toBe(2);
    expect(
      (await request(app).get(`/api/events/${f.event.id}/ticket-types`)).body[0]
        .quantitySold,
    ).toBe(2);
    expect((await adminDetail(f.event.id)).event.ticketsSold).toBe(0);
    expect((await adminDetail(f.event.id)).ticketTypes[0].quantitySold).toBe(0);
    await SeatHoldModel.updateOne(
      { _id: held.hold.body.holdId },
      { expiresAt: new Date(Date.now() - 1) },
    );
    await Promise.all([expireHolds(), expireHolds()]);
    expect((await EventModel.findById(f.event._id))?.seatsHeld).toBe(0);
    expect((await TicketTypeModel.findById(f.type._id))?.quantityHeld).toBe(0);
    expect(
      (await request(app).get(`/api/events/${f.event.slug}`)).body.ticketsSold,
    ).toBe(0);
  });
  it("cannot oversell when two buyers race for the last seat", async () => {
    const f = await fixture(0, 1);
    const body = {
      eventId: f.event.id,
      items: [{ ticketTypeId: f.type.id, quantity: 1 }],
    };
    const results = await Promise.all([
      agent().post("/api/checkout/holds").send(body),
      agent().post("/api/checkout/holds").send(body),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await SeatHoldModel.countDocuments({ state: "active" })).toBe(1);
    expect((await EventModel.findById(f.event.id))?.seatsHeld).toBe(1);
    expect(
      (await request(app).get("/api/events?status=sold_out")).body.items.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([f.event.id]);
    expect((await request(app).get("/api/events?status=open")).body.total).toBe(
      0,
    );
  });
  it("enforces each ticket-type limit, even when event capacity has room", async () => {
    const f = await fixture(0, 5);
    await TicketTypeModel.updateOne({ _id: f.type.id }, { quantityLimit: 1 });
    await reserve(agent(), f);
    const response = await agent()
      .post("/api/checkout/holds")
      .send({
        eventId: f.event.id,
        items: [{ ticketTypeId: f.type.id, quantity: 1 }],
      });
    expect(response.status).toBe(409);
    expect((await EventModel.findById(f.event.id))?.seatsHeld).toBe(1);
  });
  it("validates the maximum, duplicate quantities, attendees, hold ownership, exact selection and browser amounts", async () => {
    const f = await fixture(),
      client = agent(),
      held = await reserve(client, f);
    for (const items of [
      [{ ticketTypeId: f.type.id, quantity: 11 }],
      [{ ticketTypeId: f.type.id, quantity: 0.5 }],
      [
        { ticketTypeId: f.type.id, quantity: 6 },
        { ticketTypeId: f.type.id, quantity: 5 },
      ],
    ])
      expect(
        (
          await client
            .post("/api/checkout/holds")
            .send({ eventId: f.event.id, items })
        ).status,
      ).toBe(400);
    for (const patch of [
      { amountKobo: 1 },
      { attendees: [] },
      { attendees: [{ ticketTypeId: f.type.id, fullName: "" }] },
    ])
      expect(
        (await client.post("/api/checkout").send({ ...held.input, ...patch }))
          .status,
      ).toBe(400);
    expect((await agent().post("/api/checkout").send(held.input)).status).toBe(
      410,
    );
    expect(
      (
        await client.post("/api/checkout").send({
          ...held.input,
          items: [{ ticketTypeId: f.type.id, quantity: 2 }],
          attendees: [held.input.attendees[0], held.input.attendees[0]],
        })
      ).body.code,
    ).toBe("hold_mismatch");
    expect(await OrderModel.countDocuments()).toBe(0);
  });
  it.each(["draft", "sales_closed", "cancelled", "completed"])(
    "blocks new holds for %s events",
    async (status) => {
      const f = await fixture();
      await EventModel.updateOne({ _id: f.event.id }, { status });
      expect(
        (
          await agent()
            .post("/api/checkout/holds")
            .send({
              eventId: f.event.id,
              items: [{ ticketTypeId: f.type.id, quantity: 1 }],
            })
        ).status,
      ).toBe(409);
    },
  );
  it("rejects expired holds with 410 and expires pending-order resume without extending its deadline", async () => {
    const item = await started();
    const resumed = await item.client
      .post(`/api/checkout/${item.id}/resume`)
      .send({});
    expect(resumed.body).toEqual(item.response.body);
    expect(vi.mocked(initializePayment)).toHaveBeenCalledTimes(1);
    expect(
      (
        await SeatHoldModel.findById(item.input.holdId)
      )?.expiresAt.toISOString(),
    ).toBe(item.hold.body.expiresAt);
    await SeatHoldModel.updateOne(
      { _id: item.input.holdId },
      { expiresAt: new Date(Date.now() - 1) },
    );
    expect(
      (await item.client.post(`/api/checkout/${item.id}/resume`).send({}))
        .status,
    ).toBe(410);
    expect((await EventModel.findById(item.event.id))?.seatsHeld).toBe(0);
  });
  it("matches frontend fee rounding, threshold and cap, including free orders", () => {
    for (const amount of [
      0, 1, 33, 34, 199999, 249999, 250000, 250001, 2200000, 20000000,
    ])
      expect(paystackFeeKobo(amount)).toBe(frontendFee(amount));
  });
  it("issues free tickets without contacting Paystack; repeated starts and polls issue exactly once", async () => {
    const item = await started(0, 2);
    expect(Object.keys(item.response.body).sort()).toEqual([
      "amountKobo",
      "checkoutId",
      "feeBreakdown",
      "reference",
    ]);
    expect((await poll(item)).body).toMatchObject({
      status: "paid",
      amountKobo: 0,
      isGuest: true,
      accountCreated: false,
    });
    expect(
      (await item.client.post("/api/checkout").send(item.input)).body,
    ).toEqual(item.response.body);
    expect(await TicketModel.countDocuments()).toBe(2);
    expect(vi.mocked(initializePayment)).not.toHaveBeenCalled();
    expect(vi.mocked(verifyPayment)).not.toHaveBeenCalled();
    expect(
      (await EventModel.findById(item.event.id))?.toObject(),
    ).toMatchObject({ ticketsSold: 2, seatsHeld: 0 });
    expect(await AuditLogModel.countDocuments({ action: "order.paid" })).toBe(
      1,
    );
  });
  it("signs actual issued QR payloads that pass frontend verifyTicketQr with no personal data", async () => {
    const item = await started(0),
      status = (await poll(item)).body;
    const ticket = status.tickets[0];
    const key = (await EventSigningKeyModel.findOne({
      eventId: item.event.id,
    }).select("+privateKey"))!;
    expect(
      await verifyTicketQr(ticket.qrToken, key.publicKeyJwk),
    ).toMatchObject({ code: ticket.code, eventId: item.event.id });
    expect(
      await verifyTicketQr(
        ticket.qrToken.replace(ticket.code, "HIP-AAAA-AAAA"),
        key.publicKeyJwk,
      ),
    ).toBeNull();
    expect(Buffer.from(ticket.qrToken.split(".")[2], "base64url")).toHaveLength(
      64,
    );
    expect(ticket.code).toMatch(/^HIP-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(ticket.qrToken).not.toContain(item.input.buyer.email);
    expect(key.privateKey).toMatch(/^v1:/);
    expect(JSON.stringify(status)).not.toMatch(
      /privateKey|passwordHash|ownerHash|deliveryPayload/,
    );
    expect(Object.keys(ticket).sort()).toEqual(
      [
        "code",
        "event",
        "eventId",
        "holder",
        "id",
        "isGuest",
        "issuedAt",
        "paymentId",
        "qrToken",
        "status",
        "ticketTypeId",
        "ticketTypeName",
      ].sort(),
    );
  });
  it("recalculates prices on the server, freezes paid-order amounts, and keeps unverified payments ticket-free", async () => {
    const item = await started(200000);
    expect(item.response.body.amountKobo).toBe(213198);
    expect(vi.mocked(initializePayment).mock.calls[0][0]).toMatchObject({
      amountKobo: 213198,
      email: item.input.buyer.email,
      channel: "card",
    });
    expect((await poll(item)).body).toMatchObject({
      status: "pending",
      tickets: [],
    });
    await TicketTypeModel.updateOne(
      { _id: item.type.id },
      { priceKobo: 999999 },
    );
    providerStatus = "success";
    expect((await poll(item)).body).toMatchObject({
      status: "paid",
      amountKobo: 213198,
    });
    expect((await TicketModel.findOne())?.pricePaidKobo).toBe(200000);
  });
  it("handles repeated webhooks and polling concurrently without duplicate tickets, charges, keys or sales", async () => {
    const item = await started(250000, 3);
    providerStatus = "success";
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 ? poll(item) : webhook(item.response.body.reference),
      ),
    );
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(await TicketModel.countDocuments()).toBe(3);
    expect(await EventSigningKeyModel.countDocuments()).toBe(1);
    expect(
      (await EventModel.findById(item.event.id))?.toObject(),
    ).toMatchObject({ ticketsSold: 3, seatsHeld: 0 });
    expect(
      (await TicketTypeModel.findById(item.type.id))?.toObject(),
    ).toMatchObject({ quantitySold: 3, quantityHeld: 0 });
    expect(await AuditLogModel.countDocuments({ action: "order.paid" })).toBe(
      1,
    );
    expect(mail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(initializePayment)).toHaveBeenCalledTimes(1);
  });
  it.each([
    { amount: 1 },
    { currency: "USD" },
    { reference: "another-reference" },
  ])(
    "rejects provider mismatches and audits them without tickets (%j)",
    async (patch) => {
      const item = await started();
      providerStatus = "success";
      providerPatch = patch;
      const status = await poll(item);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ status: "failed", tickets: [] });
      expect((await OrderModel.findById(item.id))?.paymentReview).toBe(true);
      expect(await TicketModel.countDocuments()).toBe(0);
      expect(
        await AuditLogModel.countDocuments({
          action: "payment.verification_failed",
        }),
      ).toBe(1);
    },
  );
  it("records provider outages and failed payments without treating a transport failure as a charge decline", async () => {
    const item = await started();
    vi.mocked(verifyPayment).mockRejectedValueOnce(
      new Error("Private provider diagnostic"),
    );
    const unavailable = await poll(item);
    expect(unavailable.status).toBe(500);
    expect(unavailable.body.message).not.toContain("diagnostic");
    expect((await OrderModel.findById(item.id))?.status).toBe("pending");
    expect(
      await AuditLogModel.countDocuments({
        action: "payment.verification_failed",
      }),
    ).toBe(1);
    providerStatus = "failed";
    expect((await poll(item)).body.status).toBe("failed");
    expect(await TicketModel.countDocuments()).toBe(0);
  });
  it("requires the exact raw-body HMAC before processing a webhook and verifies again with Paystack", async () => {
    const item = await started();
    providerStatus = "success";
    const invalid = await request(app)
      .post("/api/webhooks/paystack")
      .set("x-paystack-signature", "0".repeat(128))
      .send({
        event: "charge.success",
        data: { reference: item.response.body.reference },
      });
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe("invalid_signature");
    expect(vi.mocked(verifyPayment)).not.toHaveBeenCalled();
    expect((await webhook(item.response.body.reference)).status).toBe(200);
    expect(vi.mocked(verifyPayment)).toHaveBeenCalledWith(
      item.response.body.reference,
    );
    expect(await TicketModel.countDocuments()).toBe(1);
  });
  it("cannot oversell when a delayed successful confirmation races with a new reservation after expiry", async () => {
    const f = await fixture(250000, 1),
      first = agent(),
      held = await reserve(first, f);
    const response = await first.post("/api/checkout").send(held.input);
    await SeatHoldModel.updateOne(
      { _id: held.input.holdId },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    providerStatus = "success";
    providerPatch = { paid_at: new Date(Date.now() - 2000).toISOString() };
    const nextBuyer = agent();
    const [status, nextHold] = await Promise.all([
      first.get(`/api/checkout/${response.body.checkoutId}`),
      nextBuyer
        .post("/api/checkout/holds")
        .send({ eventId: f.event.id, items: held.input.items }),
    ]);
    expect(status.status).toBe(200);
    const event = (await EventModel.findById(f.event.id))!;
    expect(event.ticketsSold + event.seatsHeld).toBeLessThanOrEqual(1);
    expect([
      ["paid", 409],
      ["failed", 200],
    ]).toContainEqual([status.body.status, nextHold.status]);
    expect(await TicketModel.countDocuments()).toBe(
      status.body.status === "paid" ? 1 : 0,
    );
  });
  it("retains a payment-review record if money arrives after the hold expired", async () => {
    const item = await started();
    await SeatHoldModel.updateOne(
      { _id: item.input.holdId },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    providerStatus = "success";
    expect((await poll(item)).body).toMatchObject({
      status: "failed",
      tickets: [],
    });
    expect((await OrderModel.findById(item.id))?.paymentReview).toBe(true);
    expect(await TicketModel.countDocuments()).toBe(0);
  });
  it("rolls tickets, inventory, links, key and successful audit back together when audit insertion fails", async () => {
    const item = await started();
    providerStatus = "success";
    const spy = vi
      .spyOn(audit, "appendAudit")
      .mockRejectedValueOnce(new Error("Audit unavailable"));
    expect((await poll(item)).status).toBe(500);
    expect(await TicketModel.countDocuments()).toBe(0);
    expect(await EventSigningKeyModel.countDocuments()).toBe(0);
    expect(await GuestTicketLinkModel.countDocuments()).toBe(0);
    expect(
      (await EventModel.findById(item.event.id))?.toObject(),
    ).toMatchObject({ ticketsSold: 0, seatsHeld: 1 });
    spy.mockRestore();
    expect((await poll(item)).body.status).toBe("paid");
  });
  it("preserves paid tickets on SMTP failure and retries the encrypted outbox", async () => {
    mail.mockRejectedValue(new Error("SMTP unavailable"));
    const item = await started(0);
    expect((await poll(item)).body.status).toBe("paid");
    const order = (await OrderModel.findById(item.id).select(
      "+deliveryPayload",
    ))!;
    expect(order.deliveryState).toBe("pending");
    expect(order.deliveryPayload).toMatch(/^v1:/);
    expect(order.deliveryPayload).not.toContain("token=");
    mail.mockResolvedValue(undefined);
    await GuestTicketLinkModel.updateMany(
      {},
      { expiresAt: new Date(Date.now() - 1) },
    );
    await OrderModel.updateOne(
      { _id: item.id },
      { $unset: { deliveryLeaseUntil: 1 } },
    );
    await retryTicketMail();
    expect(
      (await GuestTicketLinkModel.findOne())!.expiresAt.getTime(),
    ).toBeGreaterThan(Date.now());
    expect((await OrderModel.findById(item.id))?.deliveryState).toBe("sent");
    expect(await TicketModel.countDocuments()).toBe(1);
  });
  it("redeems a guest link once, grants refresh access to that browser, and rejects another browser", async () => {
    const item = await started(0);
    const link = mail.mock.calls[0][0].text.match(
      /http:\/\/localhost:5173\/tickets\/[^\s]+/,
    )![0];
    const url = new URL(link),
      viewer = agent();
    const route = `/api${url.pathname}${url.search}`;
    expect((await viewer.get(route)).status).toBe(200);
    expect((await viewer.get(`/api${url.pathname}`)).status).toBe(200);
    expect((await agent().get(route)).status).toBe(404);
    expect((await agent().get(`/api/checkout/${item.id}`)).status).toBe(404);
    const stored = (await GuestTicketLinkModel.findOne().select("+tokenHash"))!;
    expect(stored.tokenHash).not.toBe(url.searchParams.get("token"));
    expect(stored.usedAt).toBeInstanceOf(Date);
  });
  it("returns the identical recovery reply for known and unknown contacts, including mail failure", async () => {
    const item = await started(0);
    const known = await request(app)
      .post("/api/tickets/guest-link")
      .send({ contact: item.input.buyer.email });
    const unknown = await request(app)
      .post("/api/tickets/guest-link")
      .send({ contact: "unknown@example.com" });
    expect([known.status, unknown.status]).toEqual([204, 204]);
    expect(known.text).toBe(unknown.text);
    mail.mockRejectedValue(new Error("SMTP unavailable"));
    expect(
      (
        await request(app)
          .post("/api/tickets/guest-link")
          .send({ contact: item.input.buyer.phone })
      ).status,
    ).toBe(204);
  });
  it("merges guest buyer and attendee tickets only after a contact is verified", async () => {
    const item = await started(0, 2);
    const signup = await request(app)
      .post("/api/auth/user-signup")
      .send({
        ...item.input.buyer,
        password: `${randomBytes(16).toString("hex")}1!`,
      });
    expect(signup.status).toBe(201);
    expect(signup.body.guestTicketsToMerge).toBe(2);
    const code = mail.mock.calls.at(-1)![0].text.match(/\b\d{6}\b/)![0];
    expect(
      await TicketModel.countDocuments({ holderUserId: { $exists: true } }),
    ).toBe(0);
    const verify = await request(app)
      .post("/api/auth/user-verify")
      .send({ verificationId: signup.body.verificationId, code });
    expect(verify.status).toBe(200);
    expect(verify.body.mergedTickets).toBe(2);
    const cookies = String(verify.headers["set-cookie"][0]).split(";")[0];
    const mine = await request(app)
      .get("/api/me/tickets")
      .set("Cookie", cookies);
    expect(mine.status).toBe(200);
    expect(mine.body.tickets).toHaveLength(2);
    expect(
      mine.body.tickets.every(
        (ticket: { heldByMe: boolean; boughtByMe: boolean }) =>
          ticket.heldByMe && ticket.boughtByMe,
      ),
    ).toBe(true);
  });
  it("does not merge on an unverified phone; phone verification links its guest tickets", async () => {
    const item = await started(0);
    const user = await UserModel.create({
      fullName: "Phone owner",
      email: "different@example.com",
      phone: item.input.buyer.phone,
      passwordHash: randomBytes(24).toString("hex"),
      status: "active",
      emailVerified: true,
    });
    const session = createSession(user);
    const cookie = `hip_session=${session.token}`;
    expect(
      (await request(app).get("/api/me/tickets").set("Cookie", cookie)).body
        .tickets,
    ).toEqual([]);
    const verificationId = `ver_${randomBytes(16).toString("hex")}`,
      code = String(randomInt(100000, 1000000));
    await VerificationCodeModel.create({
      userId: user._id,
      verificationId,
      channel: "phone",
      codeHash: hashCode(verificationId, code),
      expiresAt: new Date(Date.now() + 60000),
      resendAvailableAt: new Date(),
      attempts: 0,
    });
    const verified = await request(app)
      .post("/api/auth/user-verify")
      .send({ verificationId, code });
    expect(verified.status).toBe(200);
    expect(verified.body.mergedTickets).toBe(1);
  });
  it("separates buyer and attendee ownership, exposes valid pending orders and denies unrelated hikers", async () => {
    const a = buyer(),
      b = buyer(),
      unrelated = buyer();
    const users = [];
    for (const contact of [a, b, unrelated])
      users.push(
        await UserModel.create({
          ...contact,
          passwordHash: randomBytes(32).toString("hex"),
          status: "active",
          emailVerified: true,
        }),
      );
    const cookies = users.map(
      (user) => `hip_session=${createSession(user).token}`,
    );
    const f = await fixture(),
      client = agent(),
      held = await reserve(client, f, 2);
    const browserCookie = held.hold.headers["set-cookie"]
      .find((value: string) => value.startsWith("hip_checkout="))
      .split(";")[0];
    const response = await client
      .post("/api/checkout")
      .set("Cookie", `${browserCookie}; ${cookies[0]}`)
      .send({
        ...held.input,
        buyer: a,
        attendees: [
          { ticketTypeId: f.type.id, ...a },
          { ticketTypeId: f.type.id, ...b },
        ],
      });
    expect(response.status).toBe(200);
    const pending = await request(app)
      .get("/api/me/tickets")
      .set("Cookie", cookies[0]);
    expect(pending.body.pending).toHaveLength(1);
    expect(pending.body.pending[0]).toMatchObject({
      checkoutId: response.body.checkoutId,
      buyerEmail: a.email,
      amountKobo: 543147,
    });
    providerStatus = "success";
    expect(
      (await client.get(`/api/checkout/${response.body.checkoutId}`)).body
        .status,
    ).toBe("paid");
    const mine = await request(app)
      .get("/api/me/tickets")
      .set("Cookie", cookies[0]);
    expect(mine.body.tickets).toHaveLength(2);
    expect(
      mine.body.tickets.filter(
        (ticket: { heldByMe: boolean }) => ticket.heldByMe,
      ),
    ).toHaveLength(1);
    expect(
      mine.body.tickets.every(
        (ticket: { boughtByMe: boolean }) => ticket.boughtByMe,
      ),
    ).toBe(true);
    const attendee = await request(app)
      .get("/api/me/tickets")
      .set("Cookie", cookies[1]);
    expect(attendee.body.tickets).toHaveLength(1);
    expect(attendee.body.tickets[0]).toMatchObject({
      heldByMe: true,
      boughtByMe: false,
    });
    expect(
      (
        await request(app)
          .get(`/api/tickets/${mine.body.tickets[0].code}`)
          .set("Cookie", cookies[2])
      ).status,
    ).toBe(404);
    expect((await request(app).get("/api/me/tickets")).status).toBe(401);
  });
  it("rejects expired emailed tokens without disclosing whether a ticket exists", async () => {
    await started(0);
    const link = new URL(
      mail.mock.calls[0][0].text.match(
        /http:\/\/localhost:5173\/tickets\/[^\s]+/,
      )![0],
    );
    await GuestTicketLinkModel.updateMany(
      {},
      { expiresAt: new Date(Date.now() - 1) },
    );
    const expired = await agent().get(`/api${link.pathname}${link.search}`);
    const unknown = await agent().get("/api/tickets/HIP-AAAA-AAAA");
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(unknown.body);
    expect(
      (await agent().get("/api/tickets/HIP-7Q4K-2291?token=invalid")).status,
    ).toBe(404);
  });
  it("rejects monetary overflow before initializing a payment", async () => {
    const f = await fixture(Number.MAX_SAFE_INTEGER),
      client = agent(),
      held = await reserve(client, f, 2);
    const response = await client.post("/api/checkout").send(held.input);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("amount_too_large");
    expect(vi.mocked(initializePayment)).not.toHaveBeenCalled();
    expect(await OrderModel.countDocuments()).toBe(0);
  });
  it("does not attach anonymous unpaid orders to an account just because their typed buyer email matches", async () => {
    const item = await started();
    const user = await UserModel.create({
      ...item.input.buyer,
      passwordHash: randomBytes(32).toString("hex"),
      status: "active",
      emailVerified: true,
    });
    const cookie = `hip_session=${createSession(user).token}`;
    const mine = await request(app)
      .get("/api/me/tickets")
      .set("Cookie", cookie);
    expect(mine.body).toEqual({
      tickets: [],
      pending: [],
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
      counts: {
        upcoming: 0,
        upcomingBoughtForOthers: 0,
        past: 0,
        cancelled: 0,
        pending: 0,
      },
    });
    expect(
      (await request(app).get(`/api/checkout/${item.id}`).set("Cookie", cookie))
        .status,
    ).toBe(404);
    expect((await poll(item)).body.status).toBe("pending");
  });
  it("creates only an unverified optional account and never treats checkout as email proof", async () => {
    const f = await fixture(0),
      client = agent(),
      held = await reserve(client, f);
    const response = await client
      .post("/api/checkout")
      .send({ ...held.input, createAccount: true });
    expect(response.status).toBe(200);
    const status = await client.get(
      `/api/checkout/${response.body.checkoutId}`,
    );
    expect(status.body).toMatchObject({
      status: "paid",
      isGuest: true,
      accountCreated: true,
    });
    const user = (await UserModel.findOne({ email: held.input.buyer.email }))!;
    expect(user.status).toBe("unverified");
    expect(user.emailVerified).toBe(false);
    expect((await client.get("/api/auth/me")).body).toBeNull();
    expect(status.body.tickets[0].holderUserId).toBeUndefined();
  });
});

describe("Settlement settings and verified splits", () => {
  async function staff(role = AdminRole.SUPER_ADMIN) {
    const value = await AdminModel.create({
      fullName: "Settlement manager",
      email: `${randomBytes(6).toString("hex")}@example.com`,
      passwordHash: "not-a-login-credential",
      role,
      twoStepEnabled: true,
      twoStepEnabledAt: new Date(),
    });
    return `hip_staff_session=${createStaffSession(value, "full").token}`;
  }
  const policy = {
    platformFeePercent: 5,
    platformFeeMode: "added_to_buyer",
    platformFeeOnRefund: "refund",
    paystackFeeBearer: "hiker",
  };
  const account = {
    bankCode: "057",
    accountNumber: "0000000000",
    accountName: "Settlement test account",
  };
  it("requires super admin for every settings action and rejects invalid rates", async () => {
    for (const role of [
      AdminRole.ADMIN,
      AdminRole.CHECKIN_STAFF,
      AdminRole.ADVERTISER,
    ]) {
      const cookie = await staff(role);
      for (const [method, path, body] of [
        ["get", "settings", undefined],
        ["put", "settings", policy],
        ["post", "subaccount", account],
      ] as const) {
        const res = await request(app)
          [method](`/api/admin/checkout/${path}`)
          .set("Cookie", cookie)
          .send(body);
        expect(res.status).toBe(403);
      }
    }
    const cookie = await staff();
    for (const rate of [0, -1, 101, 0.001])
      expect(
        (
          await request(app)
            .put("/api/admin/checkout/settings")
            .set("Cookie", cookie)
            .send({ ...policy, platformFeePercent: rate })
        ).status,
      ).toBe(400);
    expect(
      (
        await request(app)
          .put("/api/admin/checkout/settings")
          .set("Cookie", cookie)
          .send({ ...policy, platformFeePercent: 6.25 })
      ).body.platformFeePercent,
    ).toBe(6.25);
    expect(
      await AuditLogModel.countDocuments({
        action: "checkout.settings_updated",
      }),
    ).toBe(1);
  });
  it("keeps free checkout available, but refuses paid checkout without a rate or group subaccount", async () => {
    await CheckoutSettingsModel.updateOne(
      { _id: "checkout" },
      { $unset: { subaccountCode: 1 } },
    );
    const free = await started(0);
    expect((await poll(free)).body.status).toBe("paid");
    const f = await fixture(),
      client = agent(),
      held = await reserve(client, f);
    expect(
      (await client.post("/api/checkout").send(held.input)).body.code,
    ).toBe("settlement_not_configured");
    await CheckoutSettingsModel.updateOne(
      { _id: "checkout" },
      { $unset: { platformFeePercent: 1 } },
    );
    expect(
      (await client.post("/api/checkout").send(held.input)).body.code,
    ).toBe("platform_fee_not_configured");
    expect(await OrderModel.countDocuments()).toBe(1);
    expect(initializePayment).not.toHaveBeenCalled();
  });
  it("checks account name, masks bank details, registers idempotently and audits in the same transaction", async () => {
    await CheckoutSettingsModel.updateOne(
      { _id: "checkout" },
      { $unset: { subaccountCode: 1 } },
    );
    const cookie = await staff();
    vi.mocked(paystackDomain).mockReturnValue("live");
    vi.mocked(resolveSettlementAccount).mockResolvedValue({
      accountName: account.accountName,
      accountNumber: account.accountNumber,
    });
    vi.mocked(createSettlementSubaccount).mockResolvedValue({
      code: "ACCT_registered",
      domain: "live",
      accountName: account.accountName,
    });
    const post = (body = account) =>
      request(app)
        .post("/api/admin/checkout/subaccount")
        .set("Cookie", cookie)
        .send(body);
    expect(
      (await post({ ...account, accountName: "Wrong name" })).body,
    ).toMatchObject({ code: "account_name_mismatch", field: "accountName" });
    expect(createSettlementSubaccount).not.toHaveBeenCalled();
    const result = await post();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      paidCheckoutReady: true,
      settlement: { subaccountCode: "ACCT_registered", accountLast4: "0000" },
    });
    expect(JSON.stringify(result.body)).not.toMatch(
      /accountNumber|Fingerprint|Lease/,
    );
    const stored = await CheckoutSettingsModel.findById("checkout");
    expect(JSON.stringify(stored)).not.toContain(account.accountNumber);
    expect((await post()).status).toBe(200);
    expect(vi.mocked(createSettlementSubaccount).mock.calls).toHaveLength(1);
    expect(
      (await post({ ...account, accountNumber: "1111111111" })).status,
    ).toBe(409);
    expect(
      await AuditLogModel.countDocuments({
        action: "checkout.settlement_configured",
      }),
    ).toBe(1);
  });
  it("rolls settings back when their audit write fails", async () => {
    const cookie = await staff();
    vi.spyOn(audit, "recordAudit").mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    expect(
      (
        await request(app)
          .put("/api/admin/checkout/settings")
          .set("Cookie", cookie)
          .send({ ...policy, platformFeePercent: 9 })
      ).status,
    ).toBe(500);
    expect(
      (await CheckoutSettingsModel.findById("checkout"))?.platformFeePercent,
    ).toBe(5);
  });
  it("quotes server prices, freezes policy for pending orders and sends the group split", async () => {
    const item = await started(200000);
    expect(item.response.body.feeBreakdown).toMatchObject({
      subtotalKobo: 200000,
      platformFeeKobo: 10000,
      totalKobo: 213198,
      groupNetKobo: 200000,
    });
    expect(vi.mocked(initializePayment).mock.calls[0][0]).toMatchObject({
      subaccountCode: "ACCT_fixture",
      transactionChargeKobo: 13198,
      bearer: "account",
    });
    const quote = await item.client
      .post("/api/checkout/quote")
      .send({ eventId: item.event.id, items: item.input.items });
    expect(quote.body.feeBreakdown).toEqual(item.response.body.feeBreakdown);
    await CheckoutSettingsModel.updateOne(
      { _id: "checkout" },
      { platformFeePercent: 10, paystackFeeBearer: "group" },
    );
    const resumed = await item.client
      .post(`/api/checkout/${item.id}/resume`)
      .send({});
    expect(resumed.body.feeBreakdown).toEqual(item.response.body.feeBreakdown);
    providerStatus = "success";
    expect((await poll(item)).body.status).toBe("paid");
    expect((await OrderModel.findById(item.id))?.actualGroupNetKobo).toBe(
      200000,
    );
  });
  it.each(["missing", "destination", "allocation", "domain"])(
    "refuses successful payments with a %s split mismatch",
    async (kind) => {
      const item = await started();
      providerStatus = "success";
      if (kind === "missing") providerPatch = { fees_split: null };
      if (kind === "destination")
        providerPatch = { subaccount: { subaccount_code: "ACCT_wrong" } };
      if (kind === "allocation")
        providerPatch = {
          fees_split: { paystack: 1, subaccount: 1, integration: 1 },
        };
      if (kind === "domain") providerPatch = { domain: "live" };
      expect((await poll(item)).body.status).toBe("failed");
      expect(await TicketModel.countDocuments()).toBe(0);
      expect((await OrderModel.findById(item.id))?.paymentReview).toBe(true);
    },
  );
});

it("saves dummy bank settings locally in test mode without either Paystack call", async () => {
  const actor = await AdminModel.create({
    fullName: "Test settlement admin",
    email: `${randomBytes(6).toString("hex")}@example.test`,
    passwordHash: "not-a-login-credential",
    role: AdminRole.SUPER_ADMIN,
    twoStepEnabled: true,
  });
  const cookie = `hip_staff_session=${createStaffSession(actor, "full").token}`;
  const input = {
    bankCode: "057",
    accountNumber: "0000000000",
    accountName: "Dummy test account",
  };
  await CheckoutSettingsModel.updateOne(
    { _id: "checkout" },
    { $unset: { subaccountCode: 1 } },
  );
  vi.mocked(resolveSettlementAccount)
    .mockReset()
    .mockRejectedValue(new Error("Must never be called for a test key"));
  vi.mocked(createSettlementSubaccount).mockResolvedValue({
    code: "ACCT_testOnly",
    domain: "test",
  });
  const result = await request(app)
    .post("/api/admin/checkout/subaccount")
    .set("Cookie", cookie)
    .send(input);
  expect(result.status).toBe(200);
  expect(resolveSettlementAccount).not.toHaveBeenCalled();
  expect(createSettlementSubaccount).not.toHaveBeenCalled();
  expect(result.body.settlement).toMatchObject({
    accountName: input.accountName,
    accountVerified: false,
    domain: "test",
    localTestOnly: true,
    subaccountCode: null,
  });
  expect(result.body.paidCheckoutReady).toBe(true);
  const stored = await CheckoutSettingsModel.findById("checkout");
  expect(stored?.accountVerified).toBe(false);
  expect(stored?.accountName).toBe(input.accountName);
  expect(stored?.subaccountCode).toBeUndefined();
  expect(stored?.localTestOnly).toBe(true);
  expect(
    (
      await request(app)
        .post("/api/admin/checkout/subaccount")
        .set("Cookie", cookie)
        .send(input)
    ).status,
  ).toBe(200);
  expect(
    await AuditLogModel.countDocuments({
      action: "checkout.test_settlement_saved",
    }),
  ).toBe(1);
  const f = await fixture(),
    client = agent(),
    held = await reserve(client, f);
  const start = await client.post("/api/checkout").send(held.input);
  expect(start.status).toBe(200);
  expect(start.body.settlementMode).toBe("test_unsplit");
  const quote = await client
    .post("/api/checkout/quote")
    .send({ eventId: f.event.id, items: held.input.items });
  expect(quote.body).toMatchObject({
    amountKobo: start.body.amountKobo,
    settlementMode: "test_unsplit",
  });
  expect(vi.mocked(initializePayment).mock.calls[0][0]).toMatchObject({
    settlementMode: "test_unsplit",
  });
  vi.mocked(initializePayment).mockClear();
  expect((await poll(await started(0))).body.status).toBe("paid");
  vi.mocked(paystackDomain).mockReturnValue("live");
  vi.mocked(resolveSettlementAccount).mockResolvedValue({
    accountName: "Different owner",
    accountNumber: input.accountNumber,
  });
  expect(
    (
      await request(app)
        .post("/api/admin/checkout/subaccount")
        .set("Cookie", cookie)
        .send({ ...input, registerWithPaystack: false })
    ).body.code,
  ).toBe("account_name_mismatch");
  expect(
    (await CheckoutSettingsModel.findById("checkout"))?.localTestOnly,
  ).toBe(true);
  vi.mocked(resolveSettlementAccount).mockResolvedValue({
    accountName: input.accountName,
    accountNumber: input.accountNumber,
  });
  vi.mocked(createSettlementSubaccount).mockResolvedValue({
    code: "ACCT_liveRegistered",
    domain: "live",
  });
  const live = await request(app)
    .post("/api/admin/checkout/subaccount")
    .set("Cookie", cookie)
    .send({ ...input, registerWithPaystack: false });
  expect(live.status).toBe(200);
  expect(live.body).toMatchObject({
    paidCheckoutReady: true,
    settlement: {
      localTestOnly: false,
      accountVerified: true,
      domain: "live",
      subaccountCode: "ACCT_liveRegistered",
    },
  });
});

it.each([422, 503])(
  "keeps live-mode resolution failures (%s) mandatory",
  async (status) => {
    const actor = await AdminModel.create({
      fullName: "Live settlement admin",
      email: `${randomBytes(6).toString("hex")}@example.test`,
      passwordHash: "not-a-login-credential",
      role: AdminRole.SUPER_ADMIN,
      twoStepEnabled: true,
    });
    await CheckoutSettingsModel.updateOne(
      { _id: "checkout" },
      { $unset: { subaccountCode: 1 } },
    );
    vi.mocked(paystackDomain).mockReturnValue("live");
    vi.mocked(resolveSettlementAccount)
      .mockReset()
      .mockRejectedValue(
        new AppError(
          status,
          status === 422 ? "account_resolution_failed" : "payment_unavailable",
          "Resolution failed",
        ),
      );
    const result = await request(app)
      .post("/api/admin/checkout/subaccount")
      .set(
        "Cookie",
        `hip_staff_session=${createStaffSession(actor, "full").token}`,
      )
      .send({
        bankCode: "057",
        accountNumber: "0000000000",
        accountName: "Bank test account",
      });
    expect(result.status).toBe(status);
    expect(resolveSettlementAccount).toHaveBeenCalledOnce();
    expect(createSettlementSubaccount).not.toHaveBeenCalled();
    expect(
      (await CheckoutSettingsModel.findById("checkout"))?.subaccountCode,
    ).toBeUndefined();
  },
);

it("does not save an account or audit success if subaccount creation fails", async () => {
  const actor = await AdminModel.create({
    fullName: "Settlement admin",
    email: `${randomBytes(6).toString("hex")}@example.test`,
    passwordHash: "not-a-login-credential",
    role: AdminRole.SUPER_ADMIN,
    twoStepEnabled: true,
  });
  await CheckoutSettingsModel.updateOne(
    { _id: "checkout" },
    { $unset: { subaccountCode: 1 } },
  );
  vi.mocked(paystackDomain).mockReturnValue("live");
  vi.mocked(resolveSettlementAccount).mockResolvedValue({
    accountName: "Bank test account",
    accountNumber: "0000000000",
  });
  vi.mocked(createSettlementSubaccount).mockRejectedValue(
    new AppError(
      502,
      "subaccount_creation_failed",
      "Paystack couldn’t create the settlement subaccount. Check the bank details and Paystack settings, then try again.",
    ),
  );
  const result = await request(app)
    .post("/api/admin/checkout/subaccount")
    .set(
      "Cookie",
      `hip_staff_session=${createStaffSession(actor, "full").token}`,
    )
    .send({
      bankCode: "057",
      accountNumber: "0000000000",
      accountName: "Bank test account",
      registerWithPaystack: false,
    });
  expect(result.status).toBe(502);
  expect(result.body.code).toBe("subaccount_creation_failed");
  expect(
    (
      await CheckoutSettingsModel.findById("checkout").select(
        "+setupLeaseUntil",
      )
    )?.setupLeaseUntil,
  ).toBeUndefined();
  expect(
    (await CheckoutSettingsModel.findById("checkout"))?.subaccountCode,
  ).toBeUndefined();
  expect(
    await AuditLogModel.countDocuments({
      action: "checkout.settlement_configured",
    }),
  ).toBe(0);
});

it("allocates group-borne fees from actual verified processing costs", async () => {
  await CheckoutSettingsModel.updateOne(
    { _id: "checkout" },
    { platformFeeMode: "deducted_from_group", paystackFeeBearer: "group" },
  );
  const item = await started(250000);
  expect(vi.mocked(initializePayment).mock.calls[0][0]).toMatchObject({
    amountKobo: 250000,
    transactionChargeKobo: 12500,
    bearer: "subaccount",
  });
  providerStatus = "success";
  providerPatch = {
    fees: 14000,
    fees_split: {
      paystack: 14000,
      integration: 12500,
      subaccount: 223500,
      params: { bearer: "subaccount", transaction_charge: "12500" },
    },
  };
  expect((await poll(item)).body.status).toBe("paid");
  expect((await OrderModel.findById(item.id))?.actualGroupNetKobo).toBe(223500);
});

it("allows explicit provider-backed test registration and never invents a Paystack code", async () => {
  const actor = await AdminModel.create({
    fullName: "Provider test admin",
    email: `${randomBytes(6).toString("hex")}@example.test`,
    passwordHash: "not-a-login-credential",
    role: AdminRole.SUPER_ADMIN,
    twoStepEnabled: true,
  });
  await CheckoutSettingsModel.updateOne(
    { _id: "checkout" },
    { $unset: { subaccountCode: 1 } },
  );
  const input = {
    bankCode: "057",
    accountNumber: "0000000000",
    accountName: "Test settlement",
  };
  const cookie = `hip_staff_session=${createStaffSession(actor, "full").token}`;
  const post = (body: object) =>
    request(app)
      .post("/api/admin/checkout/subaccount")
      .set("Cookie", cookie)
      .send(body);
  vi.mocked(resolveSettlementAccount).mockReset();
  expect((await post(input)).body.settlement.subaccountCode).toBeNull();
  vi.mocked(createSettlementSubaccount).mockResolvedValue({
    code: "ACCT_providerIssued",
    domain: "test",
  });
  const result = await post({ ...input, registerWithPaystack: true });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    paidCheckoutReady: true,
    settlement: {
      subaccountCode: "ACCT_providerIssued",
      localTestOnly: false,
      accountVerified: false,
    },
  });
  expect(resolveSettlementAccount).not.toHaveBeenCalled();
  expect(createSettlementSubaccount).toHaveBeenCalledOnce();
  expect((await post({ ...input, registerWithPaystack: true })).body).toEqual(
    result.body,
  );
  expect(createSettlementSubaccount).toHaveBeenCalledOnce();
});

it("rejects local-only settings with live credentials even if a code is accidentally present", async () => {
  vi.mocked(paystackDomain).mockReturnValue("live");
  await CheckoutSettingsModel.updateOne(
    { _id: "checkout" },
    { localTestOnly: true },
  );
  const f = await fixture(),
    client = agent(),
    held = await reserve(client, f);
  expect((await client.post("/api/checkout").send(held.input)).body.code).toBe(
    "settlement_not_configured",
  );
  expect(
    (
      await client
        .post("/api/checkout/quote")
        .send({ eventId: f.event.id, items: held.input.items })
    ).body.code,
  ).toBe("settlement_not_configured");
  expect(initializePayment).not.toHaveBeenCalled();
});

describe("Paystack test payments without settlement", () => {
  async function localSetup() {
    vi.mocked(resolveSettlementAccount).mockClear();
    await CheckoutSettingsModel.updateOne(
      { _id: "checkout" },
      {
        $set: { localTestOnly: true, providerDomain: "test" },
        $unset: { subaccountCode: 1 },
      },
    );
  }
  it("initializes without split fields, resumes the same reference, and verifies tickets exactly once", async () => {
    await localSetup();
    const item = await started();
    expect(item.response.body.settlementMode).toBe("test_unsplit");
    const input = vi.mocked(initializePayment).mock.calls[0][0];
    expect(input).toMatchObject({
      settlementMode: "test_unsplit",
      amountKobo: 276650,
    });
    expect(input).not.toHaveProperty("subaccountCode");
    expect(input).not.toHaveProperty("transactionChargeKobo");
    expect(input).not.toHaveProperty("bearer");
    expect(
      (await item.client.post(`/api/checkout/${item.id}/resume`).send({})).body,
    ).toEqual(item.response.body);
    expect((await poll(item)).body).toMatchObject({
      status: "pending",
      tickets: [],
      settlementMode: "test_unsplit",
    });
    providerStatus = "success";
    const results = await Promise.all([
      poll(item),
      poll(item),
      webhook(item.response.body.reference),
    ]);
    expect(results[2].status).toBe(200);
    for (const result of results.slice(0, 2))
      expect(result.body).toMatchObject({
        status: "paid",
        settlementMode: "test_unsplit",
      });
    const order = await OrderModel.findById(item.id);
    expect(order).toMatchObject({
      actualGroupNetKobo: 0,
      actualPlatformNetKobo: 0,
      actualPaystackFeeKobo: 14150,
    });
    expect(order?.splitVerifiedAt).toBeUndefined();
    expect(await TicketModel.countDocuments({ orderId: item.id })).toBe(1);
    expect(
      await AuditLogModel.countDocuments({
        action: "order.paid",
        details: /TEST PAYMENT without bank settlement/,
      }),
    ).toBe(1);
    expect(resolveSettlementAccount).not.toHaveBeenCalled();
    expect(createSettlementSubaccount).not.toHaveBeenCalled();
  });
  it.each(["amount", "currency", "domain", "split", "fees", "status"])(
    "rejects a test payment with invalid %s",
    async (kind) => {
      await localSetup();
      const item = await started();
      providerStatus = "success";
      providerPatch =
        kind === "amount"
          ? { amount: 1 }
          : kind === "currency"
            ? { currency: "USD" }
            : kind === "domain"
              ? { domain: "live" }
              : kind === "split"
                ? { subaccount: { subaccount_code: "ACCT_unexpected" } }
                : kind === "fees"
                  ? { fees: null }
                  : { status: "failed" };
      expect((await poll(item)).body.status).toBe("failed");
      expect(await TicketModel.countDocuments()).toBe(0);
      expect(
        await AuditLogModel.countDocuments({
          action: "payment.verification_failed",
        }),
      ).toBeGreaterThan(0);
    },
  );
  it("refuses resume and issuance after switching to a live key", async () => {
    await localSetup();
    const item = await started();
    vi.mocked(paystackDomain).mockReturnValue("live");
    expect(
      (await item.client.post(`/api/checkout/${item.id}/resume`).send({})).body
        .code,
    ).toBe("settlement_setup_required");
    providerStatus = "success";
    expect((await poll(item)).body.status).toBe("failed");
    expect(await TicketModel.countDocuments()).toBe(0);
    expect(initializePayment).toHaveBeenCalledTimes(1);
  });
  it("never accepts a client-selected settlement mode", async () => {
    const f = await fixture(),
      client = agent(),
      held = await reserve(client, f);
    const result = await client
      .post("/api/checkout")
      .send({ ...held.input, settlementMode: "test_unsplit" });
    expect(result.status).toBe(400);
    expect(initializePayment).not.toHaveBeenCalled();
  });
});
