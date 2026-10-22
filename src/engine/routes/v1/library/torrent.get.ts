import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { AppError, ErrorCode } from "../../../http/errors";
import { toLibraryTorrentDetail } from "../../../library";
import { torrentService } from "../../../torrents/service";
import { infoHashSchema } from "../params";
import { libraryCall, requireLibrary } from "./shared";

const schema = z.object({
  params: z.object({ infoHash: infoHashSchema }),
});

/** GET /v1/library/:infoHash → { torrent, progress } (404 when unknown). */
export const handler = appRoute({ schema }, ({ params }, _req, res) => {
  const library = requireLibrary();
  const { infoHash } = params;
  const torrent = libraryCall(() => library.getTorrent(infoHash));
  if (!torrent) {
    throw new AppError(ErrorCode.NotFound, "This torrent isn't in the library");
  }
  const progress = libraryCall(() => library.getProgress(infoHash));
  res.json(
    toLibraryTorrentDetail(
      torrent,
      progress,
      torrentService.isActive(infoHash),
    ),
  );
});
