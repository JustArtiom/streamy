import { Router } from "express";
import * as fileSubtitlesGet from "./file-subtitles.get";
import * as heartbeatPost from "./heartbeat.post";
import * as mediaGet from "./media.get";
import * as playbackDelete from "./playback.delete";
import * as playbackFileGet from "./playback-file.get";
import * as playbackPost from "./playback.post";
import * as playbackSubtitlesGet from "./playback-subtitles.get";
import * as playersDelete from "./players.delete";

// Media: media info (ffprobe), subtitles, playback sessions (ffmpeg) and
// the players they belong to.
export const mediaRouter = Router();

mediaRouter.get("/torrents/:infoHash/files/:fileIndex/media", mediaGet.handler);
mediaRouter.get(
  "/torrents/:infoHash/files/:fileIndex/subtitles",
  fileSubtitlesGet.handler,
);

mediaRouter.post("/playback", playbackPost.handler);
mediaRouter.post("/playback/:id/heartbeat", heartbeatPost.handler);
mediaRouter.delete("/playback/:id", playbackDelete.handler);
mediaRouter.get("/playback/:id/subtitles/:n", playbackSubtitlesGet.handler);
mediaRouter.get("/playback/:id/:file", playbackFileGet.handler);
mediaRouter.delete("/players/:playerId", playersDelete.handler);
