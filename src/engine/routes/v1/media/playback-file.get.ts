import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { AppError, ErrorCode } from "../../../http/errors";
import { appRoute } from "../../../http/app-route";
import { logger } from "../../../lib/logger";
import { withBlockingReload } from "../../../media/playlist";
import { playbackIdSchema } from "./params";
import { HLS_FILE_PATTERN, playbackService } from "../../../media/playback";

const schema = z.object({
  params: z.object({
    id: playbackIdSchema,
    // Only these names, ever: the value becomes part of a file path.
    file: z.string().regex(HLS_FILE_PATTERN, "Unknown playback file"),
  }),
  // Blocking playlist reload: hold the answer until segment N exists. Other
  // _HLS_* parameters (_HLS_part, _HLS_skip) are ignored.
  query: z.object({
    _HLS_msn: z.coerce.number().int().min(0).optional(),
  }),
});

/**
 * GET /v1/playback/:id/(index.m3u8 | init.mp4 | seg_00000.m4s)
 *     index.m3u8?_HLS_msn=N waits (up to 12 s) until segment N is listed.
 */
export const handler = appRoute({ schema }, async (ctx, req, res) => {
  const file = playbackService.hlsFile(ctx.params.id, ctx.params.file);

  if (file.isPlaylist) {
    const msn = ctx.query._HLS_msn;
    if (msn !== undefined) {
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });
      await playbackService.waitForSegment(ctx.params.id, msn, abort.signal);
      if (abort.signal.aborted) return;
    }

    // Small and rewritten every few seconds: read it whole, never cache it.
    const text = await readFile(file.path, "utf8").catch(() => null);
    if (text === null) {
      throw new AppError(ErrorCode.NotFound, "The playlist isn't ready yet");
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Cache-Control", "no-store");
    res.send(withBlockingReload(text));
    return;
  }

  // Segments never change once listed (ffmpeg writes them under a temp name).
  const size = await stat(file.path).then(
    (s) => s.size,
    () => null,
  );
  if (size === null) {
    throw new AppError(ErrorCode.NotFound, "This segment doesn't exist yet");
  }
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Length", size);
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  try {
    await pipeline(createReadStream(file.path), res);
  } catch (error) {
    // The player went away (seek, closed tab) or the session just stopped.
    logger.debug({ err: error }, "Playback file stream ended early");
  }
});
