import type { IEvent } from "../../../database/models/events.schema";

const HOUR = 3_600_000;
export function eventEnd(event: IEvent) {
  if (event.endsAt) return event.endsAt.getTime();
  // Existing events have a display duration rather than a structured end. Use its upper range.
  let duration = 0;
  for (const match of event.durationLabel.matchAll(
    /(?:(\d+(?:\.\d+)?)\s*[-–]\s*)?(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|h\b|minutes?|mins?)/gi,
  )) {
    const unit = match[3].toLowerCase();
    duration +=
      Number(match[2]) *
      (unit.startsWith("d") ? 24 * HOUR : unit.startsWith("m") ? 60000 : HOUR);
  }
  // Same conservative legacy grace as the frontend; Controller 8 can set endsAt explicitly.
  return (event.startsAt?.getTime() ?? Infinity) + (duration || 12 * HOUR);
}
export const eventEnded = (event: IEvent, now = Date.now()) =>
  event.status === "completed" || eventEnd(event) <= now;
export const checkInOpens = (event: IEvent) =>
  event.checkInOpensAt?.getTime() ??
  (event.startsAt?.getTime() ?? -Infinity) - 2 * HOUR;
