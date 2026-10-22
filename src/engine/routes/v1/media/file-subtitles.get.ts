import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { torrentFileParams } from "../params";
import { subtitlesService } from "../../../media/subtitles";

const schema = z.object({ params: torrentFileParams });

/** GET /v1/torrents/:infoHash/files/:fileIndex/subtitles → { cues: Cue[] } */
export const handler = appRoute({ schema }, async (ctx, _req, res) => {
  const cues = await subtitlesService.getFileCues(
    ctx.params.infoHash,
    ctx.params.fileIndex,
  );
  res.json({ cues });
});
