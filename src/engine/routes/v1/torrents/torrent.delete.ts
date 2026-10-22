import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { torrentService } from "../../../torrents/service";
import { infoHashSchema } from "../params";

const schema = z.object({
  params: z.object({ infoHash: infoHashSchema }),
  query: z.object({
    // "true" only; anything else (or nothing) keeps it in the library.
    forget: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  }),
});

/**
 * DELETE /v1/torrents/:infoHash[?forget=true]: stops it and deletes its
 * data (also when it isn't active anymore). `forget` also drops it from the
 * library (passed on to onRemoved listeners).
 */
export const handler = appRoute(
  { schema },
  async ({ params, query }, _req, res) => {
    await torrentService.remove(params.infoHash, { forget: query.forget });
    res.status(204).end();
  },
);
