import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { playbackIdSchema } from "./params";
import { playbackService } from "../../../media/playback";

const schema = z.object({
  params: z.object({ id: playbackIdSchema }),
  body: z.object({
    position: z.number().min(0),
    paused: z.boolean().default(false),
    // The subtitle shown (SubtitleTrack.id), null = off, missing = unchanged.
    subtitle: z.string().max(64).nullable().optional(),
  }),
});

/** POST /v1/playback/:id/heartbeat → { status: PlaybackStatus } */
export const handler = appRoute({ schema }, async (ctx, _req, res) => {
  const status = await playbackService.heartbeat(ctx.params.id, ctx.body);
  res.json({ status });
});
