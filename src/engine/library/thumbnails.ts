import { rmSync } from "node:fs";
import { join } from "node:path";
import type { LibraryLogger } from "./types";

// Continue-watching thumbnails: <thumbnailsDir>/<infoHash>/<fileIndex>.jpg.
// One folder per torrent, so forgetting a torrent removes one folder. Callers
// validate infoHash and fileIndex first, so these names are always safe.

export function thumbnailFile(
  thumbnailsDir: string,
  infoHash: string,
  fileIndex: number,
): string {
  return join(thumbnailsDir, infoHash, `${fileIndex}.jpg`);
}

export function thumbnailFolder(
  thumbnailsDir: string,
  infoHash: string,
): string {
  return join(thumbnailsDir, infoHash);
}

/**
 * Deletes a thumbnail file or folder, if there is one. A failure only leaves
 * a stray image behind, so it's logged rather than thrown: the database
 * change it follows has already happened.
 */
export function removeThumbnail(path: string, logger: LibraryLogger): void {
  try {
    // Retries cover Windows briefly locking a file (antivirus, indexing).
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    logger.warn({ err: error, path }, "Could not delete a thumbnail");
  }
}
