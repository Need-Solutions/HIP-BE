import { type PipelineStage, Types } from "mongoose";
import {
  OrderModel,
  type IOrder,
} from "../../../database/models/orders.schema";
import { TicketModel } from "../../../database/models/tickets.schema";
import { EventModel } from "../../../database/models/events.schema";
import { AppError } from "../../../shared/errors/app.error";
import type { TransactionsQuery } from "../validators/transactions.validator";
import {
  countedSale,
  orderNetRevenue,
  testPayment,
} from "../../checkout/services/order-finance";

const PAGE_SIZE = 10;
const EXPORT_LIMIT = 10000;
const boundary = (day: string) => new Date(`${day}T00:00:00+01:00`);
const nextDay = (day: string) => new Date(boundary(day).getTime() + 86400000);
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type ReportOrder = IOrder & {
  _id: Types.ObjectId;
  reportAt: Date;
  eventTitle: string;
  ticketRecords: { code: string }[];
  netKobo: number;
};
const projection = {
  reference: 1,
  buyer: 1,
  eventId: 1,
  lines: 1,
  subtotalKobo: 1,
  feeKobo: 1,
  amountKobo: 1,
  feeBreakdown: 1,
  actualPaystackFeeKobo: 1,
  actualGroupNetKobo: 1,
  groupNetKobo: 1,
  settlementDomain: 1,
  settlementMode: 1,
  paymentReview: 1,
  status: 1,
  paidAt: 1,
  createdAt: 1,
};
const joins: PipelineStage[] = [
  {
    $lookup: {
      from: TicketModel.collection.name,
      let: { order: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$orderId", "$$order"] } } },
        { $sort: { attendeeIndex: 1 } },
        { $project: { code: 1 } },
      ],
      as: "ticketRecords",
    },
  },
  {
    $lookup: {
      from: EventModel.collection.name,
      localField: "eventId",
      foreignField: "_id",
      pipeline: [{ $project: { title: 1 } }],
      as: "eventRecords",
    },
  },
  {
    $set: {
      eventTitle: {
        $ifNull: [
          { $arrayElemAt: ["$eventRecords.title", 0] },
          "Event unavailable",
        ],
      },
      netKobo: orderNetRevenue,
    },
  },
];
function row(order: ReportOrder) {
  const successful = order.status === "paid" && !order.paymentReview;
  const ticketCodes = order.ticketRecords.map((t) => t.code);
  return {
    reference: order.reference,
    ticketCode: ticketCodes[0],
    ticketCodes,
    ticketCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
    buyerName: order.buyer.fullName,
    buyerEmail: order.buyer.email,
    eventId: String(order.eventId),
    eventTitle: order.eventTitle,
    ticketKobo: order.subtotalKobo,
    feeKobo: order.actualPaystackFeeKobo ?? order.feeKobo,
    platformFeeKobo: order.feeBreakdown?.platformFeeKobo ?? 0,
    netKobo: successful ? order.netKobo : 0,
    amountKobo: order.amountKobo,
    status: successful
      ? "successful"
      : order.status === "pending"
        ? "pending"
        : "failed",
    paymentReview: order.paymentReview,
    paymentMode:
      order.settlementDomain ??
      (order.settlementMode === "test_unsplit" ? "test" : "unknown"),
    settlementMode:
      order.settlementMode ?? (order.settlementDomain ? "split" : "legacy"),
    createdAt: order.reportAt.toISOString(),
  };
}
const totals = {
  $group: {
    _id: null,
    grossKobo: { $sum: { $cond: [countedSale, "$amountKobo", 0] } },
    ticketSalesKobo: { $sum: { $cond: [countedSale, "$subtotalKobo", 0] } },
    feesKobo: {
      $sum: {
        $cond: [
          countedSale,
          { $ifNull: ["$actualPaystackFeeKobo", "$feeKobo"] },
          0,
        ],
      },
    },
    platformFeesKobo: {
      $sum: {
        $cond: [
          countedSale,
          { $ifNull: ["$feeBreakdown.platformFeeKobo", 0] },
          0,
        ],
      },
    },
    netKobo: { $sum: { $cond: [countedSale, "$netKobo", 0] } },
    testNetKobo: {
      $sum: { $cond: [{ $and: [countedSale, testPayment] }, "$netKobo", 0] },
    },
    pendingCount: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
    failedCount: {
      $sum: {
        $cond: [
          {
            $or: [
              { $eq: ["$status", "failed"] },
              { $eq: ["$paymentReview", true] },
            ],
          },
          1,
          0,
        ],
      },
    },
  },
};
export async function list(query: TransactionsQuery) {
  const from = boundary(query.from),
    to = nextDay(query.to);
  const prevTo = query.prevTo ? nextDay(query.prevTo) : from;
  const prevFrom = query.prevFrom
    ? boundary(query.prevFrom)
    : new Date(from.getTime() - (to.getTime() - from.getTime()));
  const status =
    query.status === "all"
      ? {}
      : query.status === "successful"
        ? { status: "paid", paymentReview: { $ne: true } }
        : query.status === "failed"
          ? { $or: [{ status: "failed" }, { paymentReview: true }] }
          : { status: query.status };
  const current = { ...status, reportAt: { $gte: from, $lt: to } };
  const previous = { ...status, reportAt: { $gte: prevFrom, $lt: prevTo } };
  const search = query.q
    ? {
        $match: {
          $or: [
            "reference",
            "buyer.fullName",
            "buyer.email",
            "ticketRecords.code",
            "eventTitle",
          ].map((field) => ({
            [field]: { $regex: escaped(query.q!), $options: "i" },
          })),
        },
      }
    : null;
  const [result] = await OrderModel.aggregate([
    { $match: { currency: "NGN" } },
    { $project: projection },
    {
      $set: {
        reportAt: {
          $cond: [
            { $eq: ["$status", "paid"] },
            { $ifNull: ["$paidAt", "$createdAt"] },
            "$createdAt",
          ],
        },
      },
    },
    {
      $match: {
        reportAt: {
          $gte: new Date(Math.min(from.getTime(), prevFrom.getTime())),
          $lt: new Date(Math.max(to.getTime(), prevTo.getTime())),
        },
      },
    },
    ...joins,
    ...(search ? [search] : []),
    {
      $facet: {
        items: [
          { $match: current },
          { $sort: { reportAt: -1, _id: -1 } },
          ...(query.all ? [] : [{ $skip: (query.page - 1) * PAGE_SIZE }]),
          { $limit: query.all ? EXPORT_LIMIT + 1 : PAGE_SIZE },
        ],
        total: [{ $match: current }, { $count: "count" }],
        summary: [{ $match: current }, totals],
        previous: [{ $match: previous }, totals],
      },
    },
  ] as PipelineStage[]);
  if (query.all && result.items.length > EXPORT_LIMIT)
    throw new AppError(
      422,
      "export_too_large",
      "Choose a smaller date range to export at most 10,000 payments.",
    );
  const summary = result.summary[0] ?? {};
  return {
    items: result.items.map(row),
    total: result.total[0]?.count ?? 0,
    page: query.all ? 1 : query.page,
    pageSize: query.all ? Math.max(1, result.items.length) : PAGE_SIZE,
    summary: {
      grossKobo: summary.grossKobo ?? 0,
      previousGrossKobo: result.previous[0]?.grossKobo ?? 0,
      ticketSalesKobo: summary.ticketSalesKobo ?? 0,
      previousTicketSalesKobo: result.previous[0]?.ticketSalesKobo ?? 0,
      feesKobo: summary.feesKobo ?? 0,
      platformFeesKobo: summary.platformFeesKobo ?? 0,
      netKobo: summary.netKobo ?? 0,
      testNetKobo: summary.testNetKobo ?? 0,
      // Refund processing and its immutable ledger come in the refund controller.
      refundsKobo: 0,
      refundCount: 0,
      refundRequests: 0,
      pendingCount: summary.pendingCount ?? 0,
      failedCount: summary.failedCount ?? 0,
    },
  };
}
export async function ticketDetail(code: string) {
  const ticket = await TicketModel.findOne({ code }).lean();
  if (!ticket) throw new AppError(404, "not_found", "Ticket not found.");
  const event = await EventModel.findById(ticket.eventId).lean();
  if (!event) throw new AppError(404, "not_found", "Ticket not found.");
  const [order] = await OrderModel.aggregate([
    { $match: { _id: ticket.orderId } },
    { $project: projection },
    { $set: { reportAt: { $ifNull: ["$paidAt", "$createdAt"] } } },
    ...joins,
  ]);
  return {
    code: ticket.code,
    status:
      ticket.status === "refund_pending" ? "refund_requested" : ticket.status,
    event: {
      id: event._id.toString(),
      title: event.title,
      startsAt: event.startsAt!.toISOString(),
      status: event.status,
    },
    ticketTypeName: ticket.ticketTypeName,
    holder: {
      name: ticket.holder.fullName,
      email: ticket.holder.email,
      phone: ticket.holder.phone,
      isGuest: !ticket.holderUserId,
      hikerId: ticket.holderUserId?.toString(),
    },
    ...(order ? { payment: row(order) } : {}),
    history: [
      {
        at: ticket.issuedAt.toISOString(),
        label: "Ticket issued",
        detail: "Issued after payment confirmation.",
      },
    ],
  };
}
