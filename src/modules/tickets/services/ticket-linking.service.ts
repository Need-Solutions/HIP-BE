import { type ClientSession, type FilterQuery, Types } from "mongoose";
import {
  UserModel,
  type IUser,
  type UserDocument,
} from "../../../database/models/users.schema";
import {
  TicketModel,
  type ITicket,
} from "../../../database/models/tickets.schema";
import { OrderModel } from "../../../database/models/orders.schema";

const verifiedContacts = (user: IUser, prefix: string) => [
  ...(user.emailVerified ? [{ [`${prefix}.email`]: user.email }] : []),
  ...(user.phoneVerified ? [{ [`${prefix}.phone`]: user.phone }] : []),
];
export async function countGuestTickets(user: IUser) {
  const matches = [
    { "holder.email": user.email },
    { "holder.phone": user.phone },
  ];
  const orders = await OrderModel.find({
    status: "paid",
    buyerUserId: { $exists: false },
    $or: [{ "buyer.email": user.email }, { "buyer.phone": user.phone }],
  }).select("_id");
  return TicketModel.countDocuments({
    $or: [
      { holderUserId: { $exists: false }, $or: matches },
      { orderId: { $in: orders.map((order) => order._id) } },
    ],
  });
}
// Called inside the same transaction as proof of the contact. Never attach using an unverified contact.
export async function mergeGuestTickets(
  user: UserDocument,
  session: ClientSession,
) {
  const holderContacts = verifiedContacts(user, "holder");
  const holderQuery: FilterQuery<ITicket> = {
    holderUserId: { $exists: false },
    $or: holderContacts.length ? holderContacts : [{ _id: null }],
  };
  const buyerContacts = verifiedContacts(user, "buyer");
  const newOrders = await OrderModel.find({
    status: "paid",
    buyerUserId: { $exists: false },
    $or: buyerContacts.length ? buyerContacts : [{ _id: null }],
  })
    .select("_id")
    .session(session);
  const oldOrders = await OrderModel.find({ buyerUserId: user._id })
    .select("_id")
    .session(session);
  const merged = await TicketModel.countDocuments({
    $and: [
      {
        $or: [
          holderQuery,
          { orderId: { $in: newOrders.map((order) => order._id) } },
        ],
      },
      {
        holderUserId: { $ne: user._id },
        orderId: { $nin: oldOrders.map((order) => order._id) },
      },
    ],
  }).session(session);
  await TicketModel.updateMany(
    holderQuery,
    { $set: { holderUserId: user._id } },
    { session },
  );
  await OrderModel.updateMany(
    {
      status: "paid",
      buyerUserId: { $exists: false },
      $or: buyerContacts.length ? buyerContacts : [{ _id: null }],
    },
    { $set: { buyerUserId: user._id } },
    { session },
  );
  return merged;
}
export async function verifiedContactUser(
  email: string | undefined,
  phone: string | undefined,
  session: ClientSession,
): Promise<Types.ObjectId | undefined> {
  const contacts = [
    ...(email ? [{ email, emailVerified: true }] : []),
    ...(phone ? [{ phone, phoneVerified: true }] : []),
  ];
  if (!contacts.length) return undefined;
  const users = await UserModel.find({
    status: "active",
    $or: contacts,
  }).session(session);
  // If two contacts resolve to different people, do not guess who the attendee is.
  if (users.length !== 1) return undefined;
  // Conflict with a concurrent contact change or verification before committing the link.
  const user = users[0];
  await UserModel.updateOne(
    { _id: user._id },
    { $inc: { ticketChanges: 1 } },
    { session },
  );
  return user._id;
}
