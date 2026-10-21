import { z } from "zod";
import { EVENT_STATUSES } from "../../../database/models/events.schema";

const id = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "Invalid event or ticket type ID")
  .toLowerCase();
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Choose a valid date");
const time = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const localDateTime = z.string().refine((value) => {
  const [day, clock] = value.split("T");
  return (
    value.length === 16 &&
    calendarDate.safeParse(day).success &&
    time.safeParse(clock).success
  );
}, "Use YYYY-MM-DDTHH:MM in Africa/Lagos");
const optionalDate = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );
const typeSchema = z
  .object({
    id: id.optional(),
    name: z
      .string()
      .trim()
      .min(2, "Give the ticket type a name")
      .max(40, "Keep it under 40 characters"),
    description: z
      .string()
      .trim()
      .max(120, "Keep it under 120 characters")
      .default(""),
    priceKobo: z
      .number()
      .int("Use whole kobo")
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    quantityLimit: z
      .number()
      .int("Whole tickets only")
      .min(1, "At least 1")
      .max(10000, "Up to 10,000"),
    salesStart: calendarDate,
    salesEnd: calendarDate,
  })
  .refine((value) => value.salesEnd >= value.salesStart, {
    path: ["salesEnd"],
    message: "Sales can’t end before they start",
  });
const fields = {
  id: id.optional(),
  title: z
    .string()
    .trim()
    .min(3, "Give the event a title (at least 3 characters)")
    .max(80, "Keep the title under 80 characters"),
  description: z.string().trim().max(20000).optional(),
  date: optionalDate(calendarDate),
  startTime: optionalDate(time),
  durationLabel: z.string().trim().max(200).optional(),
  meetingPoint: z.string().trim().max(500).optional(),
  location: z.string().trim().max(500).optional(),
  difficulty: z.enum(["easy", "moderate", "challenging"]).optional(),
  capacity: z.number().int().min(0).max(10000).optional(),
  registrationDeadline: optionalDate(localDateTime),
  requiredEquipment: z
    .array(z.string().trim().min(1).max(200))
    .max(100)
    .optional(),
  emergencyInfo: z.string().trim().max(5000).optional(),
  requirements: z.string().trim().max(5000).optional(),
  coverImageUrl: z
    .string()
    .url("Use a secure image URL")
    .max(2048)
    .refine(
      (value) => new URL(value).protocol === "https:",
      "Use a secure image URL",
    )
    .optional(),
  ticketTypes: z.array(typeSchema).max(10000).optional(),
  publish: z.boolean().default(false),
};
export const createEventSchema = z.object(fields);
export const updateEventSchema = createEventSchema.extend({
  title: fields.title.optional(),
});
export type EventInput = z.infer<typeof updateEventSchema>;
export const eventIdSchema = z.object({ id });
export const cancelEventSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters.")
    .max(2000),
});
const page = z.coerce
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .default(1);
const search = z.string().trim().max(200).default("");
const utcDate = z.string().datetime({ offset: true }).optional();
export const publicEventsQuerySchema = z
  .object({
    q: search,
    from: utcDate,
    to: utcDate,
    status: z.enum(["all", "open", "few", "sold_out", "past"]).default("all"),
    sort: z.enum(["soonest", "latest"]).default("soonest"),
    page,
    pageSize: z.coerce.number().int().min(1).max(100).default(9),
    upcoming: z.enum(["true", "false"]).optional(),
  })
  .refine(
    (value) =>
      !value.from || !value.to || new Date(value.from) <= new Date(value.to),
    { path: ["to"], message: "The end date must follow the start date" },
  );
export type PublicEventsQuery = z.infer<typeof publicEventsQuerySchema>;
export const adminEventsQuerySchema = z.object({
  status: z.enum(["all", ...EVENT_STATUSES]).default("all"),
  range: z.enum(["all", "upcoming", "past"]).default("all"),
  q: search,
  page,
});
export type AdminEventsQuery = z.infer<typeof adminEventsQuerySchema>;
