import { TicketModel } from "../../../database/models/tickets.schema";
import { CheckInModel } from "../../../database/models/check-in.schema";
import { EventModel } from "../../../database/models/events.schema";
import { reconcileAccount } from "./account-tickets.service";
import { eventEnded } from "./account-event-time";

export async function hikingHistory(userId: string) {
  await reconcileAccount(userId);
  const checkIns = await CheckInModel.find({ user: userId });
  const tickets = await TicketModel.find({
    $or: [
      { holderUserId: userId },
      { _id: { $in: checkIns.map((c) => c.ticket) } },
    ],
  });
  const events = new Map(
    (
      await EventModel.find({ _id: { $in: tickets.map((t) => t.eventId) } })
    ).map((e) => [e.id, e]),
  );
  const admissions = new Map(checkIns.map((c) => [String(c.ticket), c]));
  const entries = tickets
    .flatMap((ticket) => {
      const event = events.get(String(ticket.eventId));
      if (!event?.startsAt) return [];
      const checkIn = admissions.get(ticket.id);
      const refunded = ticket.status === "refunded";
      if (
        !checkIn &&
        !refunded &&
        (!eventEnded(event) ||
          !event.attendanceClosedAt ||
          !["confirmed", "expired", "checked_in"].includes(ticket.status) ||
          event.status === "cancelled")
      )
        return [];
      return [
        {
          ticketCode: ticket.code,
          ticketTypeName: ticket.ticketTypeName,
          pricePaidKobo: ticket.pricePaidKobo,
          event: {
            id: event.id as string,
            slug: event.slug,
            title: event.title,
            startsAt: event.startsAt.toISOString(),
            location: event.location,
            ...(event.distanceKm === undefined
              ? {}
              : { distanceKm: event.distanceKm }),
          },
          outcome: checkIn ? "attended" : refunded ? "refunded" : "missed",
          ...(checkIn
            ? {
                checkIn: {
                  at: checkIn.checkedInAt.toISOString(),
                  method: checkIn.method,
                },
              }
            : {}),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.event.startsAt.localeCompare(a.event.startsAt) ||
        a.ticketCode.localeCompare(b.ticketCode),
    );
  // One hike per event, even if a hiker had several admitted tickets for the same hike.
  const attendedEvents = new Map(
    entries.filter((e) => e.checkIn).map((e) => [e.event.id, e]),
  );
  const attended = [...attendedEvents.values()].sort((a, b) =>
    b.checkIn!.at.localeCompare(a.checkIn!.at),
  );
  return {
    entries,
    totals: {
      hikesAttended: attended.length,
      uniqueTrails: new Set(
        attended.map((e) => e.event.location.trim().toLowerCase()),
      ).size,
      mostRecentHike: attended[0] ?? null,
    },
  };
}
