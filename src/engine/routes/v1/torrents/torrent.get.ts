import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { infoHashSchema } from "../params";
import { torrentService } from "../../../torrents/service";

const schema = z.object({
  params: z.object({ infoHash: infoHashSchema }),
});

/** GET /v1/torrents/:infoHash */
export const handler = appRoute({ schema }, ({ params }, _req, res) => {
  const torrent = torrentService.get(params.infoHash);
  // Someone has its page open: it's in use. (The list doesn't count, or an
  // open home page would keep every torrent active forever.)
  torrentService.touch(params.infoHash);
  res.json({ torrent });
});
