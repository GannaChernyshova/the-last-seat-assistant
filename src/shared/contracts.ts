import { z } from "zod";

export const searchInputSchema = z.object({
  topic: z.string().min(2),
  timeOfDay: z.enum(["morning", "afternoon", "evening", "any"])
});

export const reserveInputSchema = z.object({
  workshopId: z.string().min(1)
});

export const workshopSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  tags: z.array(z.string()),
  capacity: z.number(),
  remainingCapacity: z.number()
});

export const reservationSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  workshopId: z.string(),
  workshopTitle: z.string(),
  attendeeId: z.string(),
  attendeeName: z.string(),
  attendeeEmail: z.string(),
  createdAt: z.string()
});

export const bookingTools = [
  {
    name: "search_workshops",
    description: "Find conference workshops by topic and time of day.",
    schema: searchInputSchema
  },
  {
    name: "reserve_seat",
    description: "Reserve one seat in a selected workshop.",
    schema: reserveInputSchema
  }
];
