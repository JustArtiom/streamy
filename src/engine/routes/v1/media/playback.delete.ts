import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { playbackIdSchema } from "./params";
import { playbackService } from "../../../media/playback";

const schema = z.object({ params: z.object({ id: playbackIdSchema }) });

/**
 * DELETE /v1/playback/:id → 204. Kills ffmpeg and deletes the session's
 * files. Already gone is fine too (the player may send it twice).
 */
export const handler = appRoute({ schema }, async (ctx, _req, res) => {
  await playbackService.stop(ctx.params.id);
  res.status(204).end();
});
