import { randomBytes } from "crypto";
import mongoose, { type ClientSession, Types } from "mongoose";
import {
  AdminModel,
  AdminRole,
  type AdminDocument,
} from "../../../database/models/admin.schema";
import {
  EventModel,
  type EventDocument,
} from "../../../database/models/events.schema";
import {
  TicketTypeModel,
  type TicketTypeDocument,
} from "../../../database/models/ticket-types.schema";
import { AppError } from "../../../shared/errors/app.error";
import { staffPermissionError } from "../../admin/middleware/permission.middleware";
import { recordAudit } from "../../admin/services/audit-log.service";
import type { EventInput } from "../validators/event.validator";
import { eventResponse, ticketResponse } from "./event-response";
import { expireHolds } from "../../checkout/services/seat-hold.service";

const HOUR = 3600000;
const missing = () => new AppError(404, "not_found", "Event not found.");
const invalid = (field: string, message: string, status = 422) =>
  new AppError(status, "validation_error", message, { field });
const lagosDay = (date: Date) =>
  new Date(date.getTime() + HOUR).toISOString().slice(0, 10);
const localDate = (date: string, time: string) =>
  new Date(`${date}T${time}:00+01:00`);
const draftStart = () => localDate(lagosDay(new Date()), "06:00");

const typesFor = (eventId: Types.ObjectId, session?: ClientSession) =>
  TicketTypeModel.find({ eventId })
    .sort({ position: 1, _id: 1 })
    .session(session ?? null);

async function transaction<T>(run: (session: ClientSession) => Promise<T>) {
  try {
    return await mongoose.connection.transaction(run, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 20)
      throw new AppError(
        503,
        "transactions_unavailable",
        "Event changes require a MongoDB replica set. Check the database configuration.",
      );
    throw error;
  }
}
async function actingAdmin(actor: AdminDocument, session: ClientSession) {
  // Conflict with concurrent role changes, deactivation and two-step reset, then recheck permission.
  const current = await AdminModel.findOneAndUpdate(
    {
      _id: actor._id,
      role: { $in: [AdminRole.SUPER_ADMIN, AdminRole.ADMIN] },
      status: "active",
      twoStepEnabled: true,
      sessionVersion: actor.sessionVersion,
    },
    { $inc: { staffChanges: 1 } },
    { new: true, session },
  );
  if (!current) throw staffPermissionError("manage_events");
  return current;
}
async function audit(
  actor: AdminDocument,
  event: EventDocument,
  action: string,
  details: string,
  session: ClientSession,
  reason?: string,
) {
  await recordAudit(
    actor,
    {
      action,
      target: { type: "event", id: event.id },
      details,
      ...(reason ? { reason } : {}),
    },
    session,
  );
}
function validatePublished(event: EventDocument, types: TicketTypeDocument[]) {
  if (event.description.length < 20)
    throw invalid("description", "Describe the hike in at least 20 characters");
  if (!event.scheduleSet || !event.startsAt)
    throw invalid("date", "Choose the date and start time");
  if (event.startsAt.getTime() < Date.now())
    throw invalid("date", "The start date is in the past.");
  if (!event.durationLabel)
    throw invalid(
      "durationLabel",
      "Say roughly how long it takes, e.g. “About 6 hrs” or “2 days”",
    );
  if (!event.meetingPoint)
    throw invalid("meetingPoint", "Where should hikers meet?");
  if (!event.location) throw invalid("location", "Where is the trail?");
  if (event.capacity < 1)
    throw invalid("capacity", "Enter a whole number between 1 and 10,000");
  if (
    !event.registrationDeadline ||
    event.registrationDeadline > event.startsAt
  )
    throw invalid(
      "registrationDeadline",
      "The registration deadline must be before the start.",
    );
  if (!event.emergencyInfo)
    throw invalid(
      "emergencyInfo",
      "Add emergency information (guide, medic, nearest hospital)",
    );
  if (!types.length)
    throw invalid("ticketTypes", "Add at least one ticket type.");
  for (const type of types) {
    if (lagosDay(type.salesEnd) > lagosDay(event.registrationDeadline))
      throw invalid(
        "ticketTypes",
        `“${type.name}” sales end after registration closes`,
      );
    if (type.salesStart > event.registrationDeadline)
      throw invalid(
        "ticketTypes",
        `“${type.name}” sales start after registration closes`,
      );
  }
}

export async function save(
  actor: AdminDocument,
  input: EventInput,
  id?: string,
) {
  if (input.id && input.id !== id)
    throw invalid("id", "The event ID must match the URL", 400);
  if (id) await expireHolds(id);
  // Ensure the unique slug index exists before the first create on a fresh database.
  await Promise.all([EventModel.init(), TicketTypeModel.init()]);
  // Retrying a concurrent slug collision keeps both creates, with a unique stable slug.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transaction(async (session) => {
        const currentActor = await actingAdmin(actor, session);
        let event = id ? await EventModel.findById(id).session(session) : null;
        if (id && !event) throw missing();
        const creating = !event;
        if (event && ["completed", "cancelled"].includes(event.status))
          throw new AppError(
            409,
            "event_locked",
            `A ${event.status} event can’t be edited.`,
          );
        const previousStatus = event?.status;
        if (!event) {
          const base =
            input
              .title!.toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "") || "event";
          const taken = await EventModel.exists({ slug: base }).session(
            session,
          );
          const start = draftStart();
          event = new EventModel({
            title: input.title,
            slug: taken ? `${base}-${randomBytes(4).toString("hex")}` : base,
            startsAt: start,
            registrationDeadline: new Date(start.getTime() - 2 * HOUR),
          });
        }
        const previousTypes = creating
          ? []
          : await typesFor(event._id, session);
        for (const key of [
          "title",
          "description",
          "durationLabel",
          "meetingPoint",
          "location",
          "difficulty",
          "capacity",
          "requiredEquipment",
          "emergencyInfo",
          "requirements",
          "coverImageUrl",
        ] as const) {
          if (input[key] !== undefined) event.set(key, input[key]);
        }
        // The editor sends a full EventInput; clicking Remove omits the optional cover URL.
        if (
          input.title !== undefined &&
          input.description !== undefined &&
          input.ticketTypes !== undefined &&
          input.coverImageUrl === undefined
        )
          event.coverImageUrl = undefined;
        if (input.date || input.startTime) {
          if (!input.date || !input.startTime)
            throw invalid("date", "Provide date and startTime together", 400);
          event.startsAt = localDate(input.date, input.startTime);
          event.scheduleSet = true;
          if (
            !input.registrationDeadline &&
            (creating || previousStatus === "draft")
          )
            event.registrationDeadline = new Date(
              event.startsAt.getTime() - 2 * HOUR,
            );
        }
        if (input.registrationDeadline) {
          const [day, clock] = input.registrationDeadline.split("T");
          event.registrationDeadline = localDate(day, clock);
        }
        const types: TicketTypeDocument[] = [];
        if (input.ticketTypes !== undefined) {
          const retained = new Set<string>();
          for (const [position, type] of input.ticketTypes.entries()) {
            if (type.id && retained.has(type.id))
              throw invalid(
                "ticketTypes",
                "A ticket type cannot appear twice",
                400,
              );
            const existing = previousTypes.find(
              (prior) => prior.id === type.id,
            );
            if (type.id && !existing)
              throw invalid(
                "ticketTypes",
                "Ticket type does not belong to this event",
                400,
              );
            const saved =
              existing ?? new TicketTypeModel({ eventId: event._id });
            if (type.quantityLimit < saved.quantitySold)
              throw new AppError(
                409,
                "quantity_below_sold",
                "You can’t lower a ticket limit below the quantity already sold.",
                { field: `ticketTypes.${position}.quantityLimit` },
              );
            if (type.quantityLimit < saved.quantitySold + saved.quantityHeld)
              throw new AppError(
                409,
                "quantity_below_reserved",
                "You can’t lower a ticket limit below sold tickets and active seat holds.",
                { field: `ticketTypes.${position}.quantityLimit` },
              );
            saved.set({
              name: type.name,
              description: type.description,
              priceKobo: type.priceKobo,
              quantityLimit: type.quantityLimit,
              salesStart: localDate(type.salesStart, "00:00"),
              salesEnd: localDate(type.salesEnd, "23:59"),
              position,
            });
            if (saved.status !== "paused")
              saved.status =
                saved.quantitySold >= saved.quantityLimit
                  ? "sold_out"
                  : "active";
            types.push(saved);
            retained.add(saved.id);
          }
          if (
            previousTypes.some(
              (type) => !retained.has(type.id) && type.quantitySold > 0,
            )
          )
            throw new AppError(
              409,
              "ticket_type_sold",
              "You can’t remove a ticket type that already has sales.",
              { field: "ticketTypes" },
            );
        } else types.push(...previousTypes);
        if (
          previousTypes.some(
            (type) =>
              type.quantityHeld > 0 &&
              !types.some((kept) => kept.id === type.id),
          )
        )
          throw new AppError(
            409,
            "ticket_type_held",
            "You can’t remove a ticket type with active seat holds.",
            { field: "ticketTypes" },
          );
        const totalLimit = types.reduce(
          (sum, type) => sum + type.quantityLimit,
          0,
        );
        if (totalLimit > event.capacity)
          throw invalid(
            "ticketTypes",
            "Ticket quantity limits can’t exceed the event capacity.",
          );
        if (event.capacity < event.ticketsSold)
          throw invalid(
            "capacity",
            "Capacity can’t be lower than the number of tickets already sold.",
          );
        if (event.capacity < event.ticketsSold + event.seatsHeld)
          throw invalid(
            "capacity",
            "Capacity can’t be lower than sold tickets and active seat holds.",
          );
        event.fromPriceKobo = types.length
          ? Math.min(...types.map((type) => type.priceKobo))
          : 0;
        if (input.publish || event.status !== "draft")
          validatePublished(event, types);
        if (input.publish && event.status === "draft")
          event.status = "published";
        await event.save({ session });
        if (input.ticketTypes !== undefined) {
          await TicketTypeModel.deleteMany({
            eventId: event._id,
            _id: { $nin: types.map((type) => type._id) },
          }).session(session);
          // MongoDB transactions do not support parallel operations on the same session.
          for (const type of types) await type.save({ session });
        }
        if (creating)
          await audit(
            currentActor,
            event,
            "event.created",
            `Created “${event.title}”`,
            session,
          );
        if (input.publish && (creating || previousStatus === "draft"))
          await audit(
            currentActor,
            event,
            "event.published",
            `Published “${event.title}”`,
            session,
          );
        else if (!creating)
          await audit(
            currentActor,
            event,
            "event.updated",
            `Updated “${event.title}”`,
            session,
          );
        // TODO (ticket notifications): notify holders when a published event's date, time or place changes.
        return {
          event: eventResponse(event),
          ticketTypes: types.map(ticketResponse),
        };
      });
    } catch (error) {
      if (
        !id &&
        error instanceof mongoose.mongo.MongoServerError &&
        error.code === 11000 &&
        error.keyPattern?.slug &&
        attempt < 2
      )
        continue;
      throw error;
    }
  }
  throw new AppError(
    409,
    "conflict",
    "Couldn’t allocate a unique event slug. Try again.",
  );
}

export async function closeSales(actor: AdminDocument, id: string) {
  return transaction(async (session) => {
    const currentActor = await actingAdmin(actor, session);
    const event = await EventModel.findById(id).session(session);
    if (!event) throw missing();
    if (event.status === "sales_closed") return eventResponse(event);
    if (event.status !== "published")
      throw new AppError(
        409,
        "invalid_transition",
        "Only a published event can close ticket sales.",
      );
    event.status = "sales_closed";
    await event.save({ session });
    await audit(
      currentActor,
      event,
      "event.sales_closed",
      `Closed ticket sales for “${event.title}”`,
      session,
    );
    return eventResponse(event);
  });
}
export async function cancel(actor: AdminDocument, id: string, reason: string) {
  return transaction(async (session) => {
    const currentActor = await actingAdmin(actor, session);
    const event = await EventModel.findById(id).session(session);
    if (!event) throw missing();
    if (event.status === "cancelled") return eventResponse(event);
    if (event.status === "completed")
      throw new AppError(
        409,
        "event_locked",
        "A completed event can’t be cancelled.",
      );
    event.status = "cancelled";
    event.cancellationReason = reason;
    await event.save({ session });
    await audit(
      currentActor,
      event,
      "event.cancelled",
      `Cancelled “${event.title}”`,
      session,
      reason,
    );
    // TODO (refunds): refund ticket holders in full; no refund has been issued by this controller.
    // TODO (notifications): send the cancellation reason to ticket holders.
    return eventResponse(event);
  });
}
