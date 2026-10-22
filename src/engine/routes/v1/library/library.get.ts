import { stat } from "node:fs/promises";
import type { Library } from "../../../../shared/engine-api";
import { appRoute } from "../../../http/app-route";
import {
  type ContinueWatchingEntry,
  type LibraryStore,
  thumbnailUrl,
  toLibrary,
} from "../../../library";
import { torrentService } from "../../../torrents/service";
import { libraryCall, requireLibrary } from "./shared";

const keyOf = (entry: { infoHash: string; fileIndex: number }) =>
  `${entry.infoHash}:${entry.fileIndex}`;

/** The entries whose thumbnail has been made (keys). */
async function withThumbnails(
  library: LibraryStore,
  entries: ContinueWatchingEntry[],
): Promise<Set<string>> {
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = libraryCall(() =>
        library.thumbnailPath(entry.infoHash, entry.fileIndex),
      );
      const exists = await stat(path).then(
        (stats) => stats.isFile(),
        () => false,
      );
      return exists ? keyOf(entry) : null;
    }),
  );
  return new Set(found.filter((key) => key !== null));
}

/** GET /v1/library → Library (Continue watching and Recent). */
export const handler = appRoute(async (_ctx, _req, res) => {
  const library = requireLibrary();
  const lists = libraryCall(() => ({
    continueWatching: library.listContinueWatching(),
    recent: library.listRecent(),
  }));
  const thumbnails = await withThumbnails(library, lists.continueWatching);

  const body: Library = toLibrary(lists, {
    isActive: (infoHash) => torrentService.isActive(infoHash),
    thumbnailUrlFor: (entry) =>
      thumbnails.has(keyOf(entry))
        ? thumbnailUrl(entry.infoHash, entry.fileIndex)
        : null,
  });
  res.json(body);
});
