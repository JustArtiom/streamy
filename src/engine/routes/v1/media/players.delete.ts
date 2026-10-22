import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { playerIdSchema } from "./params";
import { playbackService } from "../../../media/playback";

const schema = z.object({ params: z.object({ playerId: playerIdSchema }) });

/**
 * DELETE /v1/players/:playerId → 204. The player closed: stops all its
 * sessions (ffmpeg killed, files deleted) and any start still under way.
 * Unknown players are fine (sent with keepalive, maybe twice).
 */
export const handler = appRoute({ schema }, async (ctx, _req, res) => {
  await playbackService.stopPlayer(ctx.params.playerId);
  res.status(204).end();
});
