import { Router } from "express";
import { cacheRouter } from "./cache/router";
import * as healthGet from "./health.get";
import { libraryRouter } from "./library/router";
import { mediaRouter } from "./media/router";
import { torrentsRouter } from "./torrents/router";

// Every v1 route (all need the secret, checked in app.ts). Each part keeps
// its own router:
//   health     is the engine OK (version, ffmpeg, encoder)
//   torrents/  adding, listing, removing torrents and streaming their files
//   media/     media info, subtitles and playback sessions (ffmpeg)
//   library/   Continue watching, Recent, saved positions, thumbnails
//   cache/     the video folder's usage, and clearing it
export const v1Router = Router();

v1Router.get("/health", healthGet.handler);
v1Router.use(torrentsRouter);
v1Router.use(mediaRouter);
v1Router.use(libraryRouter);
v1Router.use(cacheRouter);
