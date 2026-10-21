import mongoose, { Schema } from "mongoose";

export const EVENT_STATUSES = [
  "draft",
  "published",
  "sales_closed",
  "completed",
  "cancelled",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export interface IEvent {
  title: string;
  slug: string;
  description: string;
  coverImageUrl?: string;
  startsAt?: Date;
  scheduleSet: boolean;
  durationLabel: string;
  meetingPoint: string;
  location: string;
  difficulty: "easy" | "moderate" | "challenging";
  capacity: number;
  registrationDeadline?: Date;
  requiredEquipment: string[];
  emergencyInfo: string;
  requirements: string;
  status: EventStatus;
  ticketsSold: number;
  seatsHeld: number;
  fromPriceKobo: number;
  distanceKm?: number;
  elevationM?: number;
  cancellationReason?: string;
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<IEvent>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String, default: "" },
    coverImageUrl: String,
    startsAt: Date,
    scheduleSet: { type: Boolean, default: false },
    durationLabel: { type: String, default: "" },
    meetingPoint: { type: String, default: "" },
    location: { type: String, default: "" },
    difficulty: {
      type: String,
      enum: ["easy", "moderate", "challenging"],
      default: "moderate",
    },
    capacity: { type: Number, min: 0, max: 10000, default: 0 },
    registrationDeadline: Date,
    requiredEquipment: { type: [String], default: [] },
    emergencyInfo: { type: String, default: "" },
    requirements: { type: String, default: "" },
    status: { type: String, enum: EVENT_STATUSES, default: "draft" },
    ticketsSold: { type: Number, min: 0, default: 0 },
    seatsHeld: { type: Number, min: 0, default: 0 },
    fromPriceKobo: { type: Number, min: 0, default: 0 },
    distanceKm: Number,
    elevationM: Number,
    cancellationReason: String,
  },
  { timestamps: true, optimisticConcurrency: true },
);
schema.index({ status: 1, startsAt: 1 });
export const EventModel = mongoose.model<IEvent>("Event", schema);
export type EventDocument = mongoose.HydratedDocument<IEvent>;
