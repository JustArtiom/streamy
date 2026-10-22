import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isGone } from "../../../cache";
import { appRoute } from "../../../http/app-route";
import { AppError, ErrorCode } from "../../../http/errors";
import { torrentFileParams } from "../params";
import { libraryCall, requireLibrary } from "./shared";

const schema = z.object({ params: torrentFileParams });

/**
 * GET /v1/library/:infoHash/files/:fileIndex/thumbnail → image/jpeg
 * 404 until it's made. It's remade as the viewer moves on, so the browser
 * revalidates every time (ETag: unchanged → 304).
 */
export const handler = appRoute({ schema }, async ({ params }, _req, res) => {
  const library = requireLibrary();
  const path = libraryCall(() =>
    library.thumbnailPath(params.infoHash, params.fileIndex),
  );
  let image: Buffer;
  try {
    image = await readFile(path);
  } catch (err) {
    if (isGone(err)) throw new AppError(ErrorCode.NotFound, "No thumbnail yet");
    throw err;
  }
  res.set("Cache-Control", "no-cache").type("image/jpeg").send(image);
});
