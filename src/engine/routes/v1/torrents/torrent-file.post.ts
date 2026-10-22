import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { openTorrent } from "./open";

const schema = z.object({
  // express.raw (in router.ts) only gives a Buffer for this content type.
  body: z.instanceof(Buffer, {
    message:
      "Send the .torrent file with Content-Type: application/x-bittorrent",
  }),
});

/** POST /v1/torrents/file (raw .torrent bytes): same answers as POST /torrents. */
export const handler = appRoute({ schema }, async ({ body }, _req, res) => {
  const { torrent, created } = await openTorrent({ torrentFile: body });
  res.status(created ? 201 : 200).json({ torrent });
});
