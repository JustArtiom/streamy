import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { engineServices } from "../../../services";
import { torrentFileParams } from "../params";
import { libraryCall, requireLibrary } from "./shared";

const schema = z.object({ params: torrentFileParams });

/**
 * DELETE /v1/library/:infoHash/files/:fileIndex → 204. Forgets the file's
 * position (and thumbnail): it leaves Continue watching.
 */
export const handler = appRoute({ schema }, ({ params }, _req, res) => {
  const library = requireLibrary();
  const { infoHash, fileIndex } = params;
  libraryCall(() => library.deleteProgress(infoHash, fileIndex));
  engineServices()?.thumbnails.forget(infoHash, fileIndex);
  res.status(204).end();
});
