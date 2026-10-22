import { Router } from "express";
import * as libraryGet from "./library.get";
import * as progressDelete from "./progress.delete";
import * as progressPut from "./progress.put";
import * as thumbnailGet from "./thumbnail.get";
import * as torrentDelete from "./torrent.delete";
import * as torrentGet from "./torrent.get";

// The library: Continue watching, Recent, saved positions, thumbnails.
export const libraryRouter = Router();

libraryRouter.get("/library", libraryGet.handler);
libraryRouter.get("/library/:infoHash", torrentGet.handler);
libraryRouter.delete("/library/:infoHash", torrentDelete.handler);
libraryRouter.put("/library/:infoHash/files/:fileIndex", progressPut.handler);
libraryRouter.delete(
  "/library/:infoHash/files/:fileIndex",
  progressDelete.handler,
);
libraryRouter.get(
  "/library/:infoHash/files/:fileIndex/thumbnail",
  thumbnailGet.handler,
);
