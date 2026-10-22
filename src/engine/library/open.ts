import { join } from "node:path";
import { logger } from "../lib/logger";
import { openInMemoryLibrary, openLibrary } from "./sqlite-library";
import { LibraryError, type LibraryStore } from "./types";

const log = logger.child({ module: "library" });

/** <dataDir>/library.db */
export const LIBRARY_FILE = "library.db";
/** <dataDir>/thumbnails/<infoHash>/<fileIndex>.jpg */
export const THUMBNAILS_DIR = "thumbnails";

/**
 * Opens <dataDir>/library.db. If it can't be used (from a newer Streamy,
 * locked, read-only…), the engine still starts, with a library in memory:
 * history from this run only, and the file left untouched for later.
 */
export function openEngineLibrary(dataDir: string): LibraryStore {
  const options = { logger: log, thumbnailsDir: join(dataDir, THUMBNAILS_DIR) };
  try {
    return openLibrary(join(dataDir, LIBRARY_FILE), options);
  } catch (err) {
    log.error(
      { err, code: err instanceof LibraryError ? err.code : undefined },
      "library.db can't be used: keeping this run's history in memory only",
    );
    return openInMemoryLibrary(options);
  }
}
