import parseTorrent from "parse-torrent";
import { z } from "zod";
import type { ProgressUpdate } from "../../../../shared/engine-api";
import { appRoute } from "../../../http/app-route";
import { AppError, ErrorCode } from "../../../http/errors";
import { type LibraryStore, toFileProgress } from "../../../library";
import { engineServices } from "../../../services";
import { torrentService } from "../../../torrents/service";
import { torrentFileParams } from "../params";
import { libraryCall, requireLibrary } from "./shared";

const schema = z.object({
  params: torrentFileParams,
  body: z.object({
    position: z.number().min(0),
    duration: z.number().min(0).nullable(),
    audioTrack: z.number().int().min(0).nullable().optional(),
    subtitle: z.string().min(1).max(64).nullable().optional(),
    watched: z.boolean().optional(),
  }) satisfies z.ZodType<ProgressUpdate>,
});

/**
 * The file's name, from the active torrent or else the saved metadata.
 * null = the torrent has no such file (or nothing is known about it).
 */
async function fileNameOf(
  library: LibraryStore,
  infoHash: string,
  fileIndex: number,
): Promise<string | null> {
  if (torrentService.isActive(infoHash)) {
    try {
      return torrentService.getFile(infoHash, fileIndex).name;
    } catch (err) {
      // Not ready or failed: the saved metadata may still say.
      if (!(err instanceof AppError)) throw err;
    }
  }
  const metadata = libraryCall(() => library.getTorrent(infoHash))?.metadata;
  if (!metadata) return null;
  const parsed = await parseTorrent(metadata).catch(() => null);
  return parsed?.files?.[fileIndex]?.name ?? null;
}

/**
 * PUT /v1/library/:infoHash/files/:fileIndex ProgressUpdate
 *   → { progress: FileProgress }
 * For when no heartbeat will come: the player closing, "Mark as watched".
 */
export const handler = appRoute(
  { schema },
  async ({ params, body }, _req, res) => {
    const library = requireLibrary();
    const { infoHash, fileIndex } = params;
    const fileName = await fileNameOf(library, infoHash, fileIndex);
    if (fileName === null) {
      throw new AppError(
        ErrorCode.NotFound,
        libraryCall(() => library.getTorrent(infoHash))
          ? "This torrent has no such file"
          : "This torrent isn't in the library",
      );
    }
    const saved = libraryCall(() =>
      library.saveProgress({ infoHash, fileIndex, fileName, ...body }),
    );
    engineServices()?.thumbnails.consider(saved);
    res.json({ progress: toFileProgress(saved) });
  },
);
