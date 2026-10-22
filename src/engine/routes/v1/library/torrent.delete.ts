import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { torrentService } from "../../../torrents/service";
import { infoHashSchema } from "../params";
import { requireLibrary } from "./shared";

const schema = z.object({
  params: z.object({ infoHash: infoHashSchema }),
});

/**
 * DELETE /v1/library/:infoHash → 204. Forgets the torrent: the same as
 * DELETE /v1/torrents/:infoHash?forget=true (it stops, its data is deleted,
 * and the library drops it through onRemoved).
 */
export const handler = appRoute({ schema }, async ({ params }, _req, res) => {
  requireLibrary();
  await torrentService.remove(params.infoHash, { forget: true });
  res.status(204).end();
});
