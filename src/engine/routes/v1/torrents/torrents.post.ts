import { z } from "zod";
import { MAX_MAGNET_LENGTH } from "../../../config";
import { appRoute } from "../../../http/app-route";
import { parseMagnetInput } from "../../../lib/magnet";
import { openTorrent } from "./open";

const PASTE_A_MAGNET = "Paste a magnet link or an info hash";

const schema = z.object({
  body: z.object(
    {
      magnet: z
        .string({ error: PASTE_A_MAGNET })
        .max(MAX_MAGNET_LENGTH, {
          error: `This magnet link is too long (the limit is ${MAX_MAGNET_LENGTH.toLocaleString("en-US")} characters)`,
        })
        .superRefine((value, ctx) => {
          const result = parseMagnetInput(value);
          if ("error" in result)
            ctx.addIssue({ code: "custom", message: result.error });
        }),
    },
    { error: PASTE_A_MAGNET },
  ),
});

/**
 * POST /v1/torrents { magnet }: 201 when added, 200 when it already was.
 * `magnet` may be a bare info hash: how the UI re-opens a torrent from the
 * library (see openTorrent).
 */
export const handler = appRoute({ schema }, async ({ body }, _req, res) => {
  const { torrent, created } = await openTorrent({ magnet: body.magnet });
  res.status(created ? 201 : 200).json({ torrent });
});
