import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { torrentFileParams } from "../params";
import { mediaInfoService } from "../../../media/media-info";

const schema = z.object({ params: torrentFileParams });

/** GET /v1/torrents/:infoHash/files/:fileIndex/media → { media: MediaInfo } */
export const handler = appRoute({ schema }, async (ctx, _req, res) => {
  const { info } = await mediaInfoService.get(
    ctx.params.infoHash,
    ctx.params.fileIndex,
  );
  res.json({ media: info });
});
