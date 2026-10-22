import { z } from "zod";
import type { CreatePlaybackRequest } from "../../../../shared/engine-api";
import { appRoute } from "../../../http/app-route";
import { AppError, ErrorCode } from "../../../http/errors";
import { infoHashSchema } from "../params";
import { playbackIdSchema, playerIdSchema } from "./params";
import { playbackService } from "../../../media/playback";

const capabilitiesSchema = z.object({
  video: z.object({
    h264: z.boolean(),
    h264High10: z.boolean(),
    hevc: z.boolean(),
    hevcMain10: z.boolean(),
    av1: z.boolean(),
    vp9: z.boolean(),
  }),
  audio: z.object({
    aac: z.boolean(),
    mp3: z.boolean(),
    opus: z.boolean(),
    flac: z.boolean(),
    ac3: z.boolean(),
    eac3: z.boolean(),
  }),
  direct: z.object({ mp4: z.boolean(), webm: z.boolean() }),
});

const playbackModeSchema = z.enum(["direct", "remux", "transcode"]);

// Mirrors CreatePlaybackRequest. Optional fields get the obvious default.
const schema = z.object({
  body: z.object({
    infoHash: infoHashSchema,
    fileIndex: z.number().int().min(0),
    start: z.number().min(0).default(0),
    audioTrack: z.number().int().min(0).nullable().default(null),
    quality: z
      .enum(["original", "1080p", "720p", "480p", "360p"])
      .default("original"),
    burnSubtitle: z.string().max(64).nullable().default(null),
    embeddedSubtitles: z.boolean().default(false),
    forceMode: playbackModeSchema.nullable().default(null),
    replaces: playbackIdSchema.nullable().default(null),
    playerId: playerIdSchema,
    capabilities: capabilitiesSchema,
  }),
});

/**
 * POST /v1/playback → 201 { playback: Playback }
 * remux/transcode wait for the first segment, so this can take a while.
 * Stops the player's other sessions first; an unfinished start of the same
 * player answers 409. 503 while the disk is almost full (except direct
 * play of a downloaded file).
 */
export const handler = appRoute({ schema }, async (ctx, _req, res) => {
  const request: CreatePlaybackRequest = ctx.body;

  // The viewer left: stop the session nobody will use. (Electron's protocol
  // handler doesn't pass a fetch abort on, hence playerId as well.)
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) {
      abort.abort(
        new AppError(ErrorCode.BadRequest, "The request was cancelled"),
      );
    }
  });

  const playback = await playbackService.create(request, abort.signal);
  res.status(201).json({ playback });
});
