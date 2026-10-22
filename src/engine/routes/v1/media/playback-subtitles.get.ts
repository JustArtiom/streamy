import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { playbackIdSchema } from "./params";
import { playbackService } from "../../../media/playback";

const schema = z.object({
  params: z.object({
    id: playbackIdSchema,
    n: z.coerce.number().int().min(0),
  }),
  query: z.object({
    from: z.coerce.number().min(0).default(0),
    to: z.coerce.number().min(0).default(Number.MAX_SAFE_INTEGER),
  }),
});

/** GET /v1/playback/:id/subtitles/:n?from&to → SubtitleCuesResponse */
export const handler = appRoute({ schema }, async (ctx, _req, res) => {
  const response = await playbackService.embeddedCues(
    ctx.params.id,
    ctx.params.n,
    ctx.query,
  );
  res.json(response);
});
