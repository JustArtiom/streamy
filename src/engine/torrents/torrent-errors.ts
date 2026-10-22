/*
 * What people read when a torrent fails (TorrentSummary.error). WebTorrent
 * fails a torrent with whatever went wrong underneath, e.g. "ENOSPC: no
 * space left on device, write '/Users/…/Movie.mkv'": raw system text, often
 * with a file name in it. The UI gets a plain sentence instead; the error
 * itself goes to the log (where the logger leaves the file names out).
 */

export const DISK_FULL = "Your disk is full.";
export const CANT_WRITE = "Streamy can't write to the video folder.";
export const FILE_BUSY =
  "A file in the video folder is busy. Try again in a moment.";
export const SOMETHING_WRONG = "Something went wrong with this torrent.";

/** Node's error code ("ENOSPC"), from the error or the start of its message. */
function systemCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === "string") return code;
  // Some libraries pass on only the message text.
  const match =
    typeof message === "string" ? /^(E[A-Z]+)\b/.exec(message) : null;
  return match?.[1] ?? null;
}

/** A sentence for people about why a torrent failed. */
export function describeTorrentError(err: unknown): string {
  switch (systemCode(err)) {
    case "ENOSPC":
    case "EDQUOT":
      return DISK_FULL;
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return CANT_WRITE;
    case "EBUSY":
      return FILE_BUSY;
    default:
      return SOMETHING_WRONG;
  }
}
