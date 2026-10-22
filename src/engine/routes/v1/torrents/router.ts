import express, { type RequestHandler, Router } from "express";
import { MAX_TORRENT_FILE_BYTES } from "../../../config";
import { AppError, ErrorCode } from "../../../http/errors";
import * as streamGet from "./stream.get";
import * as torrentDelete from "./torrent.delete";
import * as torrentGet from "./torrent.get";
import * as torrentFilePost from "./torrent-file.post";
import * as torrentsGet from "./torrents.get";
import * as torrentsPost from "./torrents.post";

// Torrents: add, list, get, remove, and stream a file's bytes.
export const torrentsRouter = Router();

/**
 * The raw .torrent bytes (the app's JSON parser ignores this type), at most
 * 10 MB: a bigger one is hostile or broken.
 */
const torrentFileBody: RequestHandler = (req, res, next) => {
  rawTorrentFile(req, res, (err?: unknown) => {
    if (
      err instanceof Error &&
      "type" in err &&
      err.type === "entity.too.large"
    ) {
      next(
        new AppError(
          ErrorCode.PayloadTooLarge,
          "This .torrent file is too big (the limit is 10 MB)",
        ),
      );
      return;
    }
    next(err);
  });
};
const rawTorrentFile = express.raw({
  type: "application/x-bittorrent",
  limit: MAX_TORRENT_FILE_BYTES,
});

torrentsRouter.post("/torrents", torrentsPost.handler);
torrentsRouter.post("/torrents/file", torrentFileBody, torrentFilePost.handler);
torrentsRouter.get("/torrents", torrentsGet.handler);
torrentsRouter.get("/torrents/:infoHash", torrentGet.handler);
torrentsRouter.delete("/torrents/:infoHash", torrentDelete.handler);
// Also answers HEAD (Express routes HEAD to GET handlers).
torrentsRouter.get(
  "/torrents/:infoHash/files/:fileIndex/stream",
  streamGet.handler,
);
