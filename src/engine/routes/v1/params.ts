import { z } from "zod";

// Path parameters shared by the v1 routes.

/** 40 hex chars, any case → lower case (the torrent's id everywhere). */
export const infoHashSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "Must be a 40-character hex info hash")
  .transform((value) => value.toLowerCase());

export const fileIndexSchema = z.coerce.number().int().min(0);

export const torrentFileParams = z.object({
  infoHash: infoHashSchema,
  fileIndex: fileIndexSchema,
});
