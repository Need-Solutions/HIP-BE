import type { Types } from "mongoose";
import type { IEvent } from "../../../database/models/events.schema";
import type { ITicketType } from "../../../database/models/ticket-types.schema";

export const eventResponse = (event: IEvent & { _id: Types.ObjectId }) => ({
  id: event._id.toString(),
  slug: event.slug,
  title: event.title,
  description: event.description,
  ...(event.coverImageUrl ? { coverImageUrl: event.coverImageUrl } : {}),
  startsAt: event.startsAt!.toISOString(),
  durationLabel: event.durationLabel,
  meetingPoint: event.meetingPoint,
  location: event.location,
  difficulty: event.difficulty,
  capacity: event.capacity,
  registrationDeadline: event.registrationDeadline!.toISOString(),
  requiredEquipment: event.requiredEquipment,
  emergencyInfo: event.emergencyInfo,
  requirements: event.requirements,
  status: event.status,
  ticketsSold: event.ticketsSold,
  fromPriceKobo: event.fromPriceKobo,
  ...(event.distanceKm === undefined ? {} : { distanceKm: event.distanceKm }),
  ...(event.elevationM === undefined ? {} : { elevationM: event.elevationM }),
});
export const ticketResponse = (
  type: ITicketType & { _id: Types.ObjectId },
) => ({
  id: type._id.toString(),
  eventId: type.eventId.toString(),
  name: type.name,
  description: type.description,
  priceKobo: type.priceKobo,
  currency: type.currency,
  quantityLimit: type.quantityLimit,
  quantitySold: type.quantitySold,
  salesStart: type.salesStart.toISOString(),
  salesEnd: type.salesEnd.toISOString(),
  status: type.quantitySold >= type.quantityLimit ? "sold_out" : type.status,
});

// Only public availability includes live holds. Admin sales/attendance always use actual sales.
export const publicEventResponse = (
  event: IEvent & { _id: Types.ObjectId },
) => ({
  ...eventResponse(event),
  ticketsSold: event.ticketsSold + (event.seatsHeld ?? 0),
});
export const publicTicketTypeResponse = (
  type: ITicketType & { _id: Types.ObjectId },
) => {
  const quantitySold = type.quantitySold + (type.quantityHeld ?? 0);
  return {
    ...ticketResponse(type),
    quantitySold,
    status: quantitySold >= type.quantityLimit ? "sold_out" : type.status,
  };
};
