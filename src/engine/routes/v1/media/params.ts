import { z } from "zod";

/** Session ids are UUIDs we made; anything else is simply not found. */
export const playbackIdSchema = z.string().min(1).max(64);

/** A random id the player picked (a UUID, or similar). It ends up in logs: plain characters only. */
export const playerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Must be 1–64 letters, digits, - or _");
