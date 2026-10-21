import { type FilterQuery, type PipelineStage, Types } from "mongoose";
import {
  EventModel,
  type IEvent,
} from "../../../database/models/events.schema";
import { TicketTypeModel } from "../../../database/models/ticket-types.schema";
import { OrderModel } from "../../../database/models/orders.schema";
import { AppError } from "../../../shared/errors/app.error";
import type {
  AdminEventsQuery,
  PublicEventsQuery,
} from "../validators/event.validator";
import {
  eventResponse,
  ticketResponse,
  publicEventResponse,
  publicTicketTypeResponse,
} from "./event-response";
import {
  expireHolds,
  inventoryLeft,
} from "../../checkout/services/seat-hold.service";

const HOUR = 3600000;
const missing = () => new AppError(404, "not_found", "Event not found.");
const typesFor = (eventId: Types.ObjectId) =>
  TicketTypeModel.find({ eventId }).sort({ position: 1, _id: 1 });

export async function adminDetail(id: string) {
  const event = await EventModel.findById(id);
  if (!event) throw missing();
  return {
    event: eventResponse(event),
    ticketTypes: (await typesFor(event._id)).map(ticketResponse),
  };
}
const escaped = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const searchFilter = (term: string, fields: string[]): FilterQuery<IEvent> =>
  term
    ? {
        $or: fields.map((field) => ({
          [field]: { $regex: escaped(term), $options: "i" },
        })),
      }
    : {};
const ordering = (now: Date, completedIsPast = true): PipelineStage[] => [
  {
    $addFields: {
      _past: completedIsPast
        ? {
            $or: [
              { $eq: ["$status", "completed"] },
              { $lt: ["$startsAt", now] },
            ],
          }
        : { $lt: ["$startsAt", now] },
    },
  },
  {
    $addFields: {
      _sortDate: {
        $cond: [
          "$_past",
          { $multiply: [{ $toLong: "$startsAt" }, -1] },
          { $toLong: "$startsAt" },
        ],
      },
    },
  },
  { $sort: { _past: 1, _sortDate: 1, _id: 1 } },
];

import {
  orderNetRevenue,
  testPayment,
} from "../../checkout/services/order-finance";

/** The event list and Overview share the same actual sales/revenue values. Holds never count here. */
export async function adminRows(
  events: (IEvent & { _id: Types.ObjectId })[],
  now: Date,
) {
  const revenue = events.length
    ? await OrderModel.aggregate<{
        _id: Types.ObjectId;
        netKobo: number;
        testNetKobo: number;
      }>([
        {
          $match: {
            eventId: { $in: events.map((event) => event._id) },
            status: "paid",
            currency: "NGN",
            paymentReview: { $ne: true },
          },
        },
        {
          $group: {
            _id: "$eventId",
            netKobo: { $sum: orderNetRevenue },
            testNetKobo: { $sum: { $cond: [testPayment, orderNetRevenue, 0] } },
          },
        },
      ])
    : [];
  const byEvent = new Map(revenue.map((row) => [String(row._id), row.netKobo]));
  const testByEvent = new Map(
    revenue.map((row) => [String(row._id), row.testNetKobo]),
  );
  return events.map((event) => ({
    event: eventResponse(event),
    confirmed: event.ticketsSold,
    capacity: event.capacity,
    // TODO (check-in controller): use actual scans, never sales-as-attendance.
    checkedIn: event.status === "completed" || event.startsAt! < now ? 0 : null,
    revenueKobo: byEvent.get(String(event._id)) ?? 0,
    testRevenueKobo: testByEvent.get(String(event._id)) ?? 0,
    // TODO (refund controller): expose completed refunds once the refund ledger exists.
    refunded: false,
    salesClosing:
      event.status === "published" &&
      event.registrationDeadline! > now &&
      event.registrationDeadline!.getTime() - now.getTime() < 72 * HOUR,
  }));
}
export async function adminList(query: AdminEventsQuery) {
  const now = new Date();
  const range: FilterQuery<IEvent> =
    query.range === "upcoming"
      ? { startsAt: { $gte: new Date(now.getTime() - 12 * HOUR) } }
      : query.range === "past"
        ? { startsAt: { $lt: now } }
        : {};
  const filter: FilterQuery<IEvent> = {
    $and: [
      range,
      query.status === "all" ? {} : { status: query.status },
      searchFilter(query.q, ["title", "location"]),
    ],
  };
  const [items, total, grouped] = await Promise.all([
    EventModel.aggregate<IEvent & { _id: Types.ObjectId }>([
      { $match: filter },
      ...ordering(now, false),
      { $skip: (query.page - 1) * 9 },
      { $limit: 9 },
    ]),
    EventModel.countDocuments(filter),
    EventModel.aggregate<{ _id: IEvent["status"]; count: number }>([
      { $match: range },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);
  const counts = {
    all: 0,
    draft: 0,
    published: 0,
    sales_closed: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const group of grouped) {
    counts[group._id] = group.count;
    counts.all += group.count;
  }
  return {
    items: await adminRows(items, now),
    total,
    page: query.page,
    pageSize: 9,
    counts,
  };
}
export async function publicList(query: PublicEventsQuery) {
  await expireHolds();
  const now = new Date();
  if (query.upcoming === "true")
    return (
      await EventModel.find({
        status: { $nin: ["draft", "cancelled"] },
        startsAt: { $gte: now },
      }).sort({ startsAt: 1, _id: 1 })
    ).map(publicEventResponse);
  const filters: FilterQuery<IEvent>[] = [
    { status: { $ne: "draft" } },
    searchFilter(query.q, ["title", "location", "meetingPoint"]),
  ];
  if (query.from || query.to)
    filters.push({
      startsAt: {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      },
    });
  const left = inventoryLeft("capacity", "ticketsSold", "seatsHeld");
  if (query.status === "open" || query.status === "few")
    filters.push({
      status: "published",
      startsAt: { $gte: now },
      registrationDeadline: { $gte: now },
      $expr:
        query.status === "few"
          ? { $and: [{ $gt: [left, 0] }, { $lte: [left, 10] }] }
          : { $gt: [left, 0] },
    });
  if (query.status === "sold_out")
    filters.push({
      status: { $nin: ["draft", "cancelled", "completed"] },
      startsAt: { $gte: now },
      $expr: { $lte: [left, 0] },
    });
  if (query.status === "past")
    filters.push({
      $or: [{ status: "completed" }, { startsAt: { $lt: now } }],
    });
  const filter = { $and: filters };
  const [items, total] = await Promise.all([
    EventModel.aggregate<IEvent & { _id: Types.ObjectId }>([
      { $match: filter },
      ...(query.sort === "latest"
        ? [{ $sort: { startsAt: -1, _id: 1 } } as PipelineStage]
        : ordering(now)),
      { $skip: (query.page - 1) * query.pageSize },
      { $limit: query.pageSize },
    ]),
    EventModel.countDocuments(filter),
  ]);
  return {
    items: items.map(publicEventResponse),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}
async function visibleEvent(idOrSlug: string) {
  const choices: FilterQuery<IEvent>[] = [{ slug: idOrSlug }];
  if (/^[a-f\d]{24}$/i.test(idOrSlug))
    choices.push({ _id: new Types.ObjectId(idOrSlug) });
  const event = await EventModel.findOne({
    status: { $ne: "draft" },
    $or: choices,
  });
  if (!event) throw missing();
  return event;
}
export async function publicDetail(idOrSlug: string) {
  const event = await visibleEvent(idOrSlug);
  await expireHolds(event.id);
  return publicEventResponse((await EventModel.findById(event._id))!);
}
export async function publicTicketTypes(id: string) {
  const event = await visibleEvent(id);
  await expireHolds(event.id);
  return (await typesFor(event._id)).map(publicTicketTypeResponse);
}
