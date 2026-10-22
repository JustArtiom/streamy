import { AppError, ErrorCode } from "../../http/errors";
import { engineServices } from "../../services";

// Checks before starting something that writes to the video folder.

export const DISK_FULL_MESSAGE =
  "Your disk is almost full. Free up some space, then try again.";

export const CLEARING_MESSAGE =
  "Streamy is deleting its downloaded videos. Try again in a moment.";

/** 503 while downloading is paused because the disk is almost full. */
export function assertEnoughDiskSpace(): void {
  if (engineServices()?.diskGuard.isLow()) {
    throw new AppError(ErrorCode.ServiceUnavailable, DISK_FULL_MESSAGE);
  }
}

/**
 * Whether a torrent that isn't active may start (AddOptions.admit). 503
 * while the videos are being cleared, and for a new torrent while the disk
 * is almost full. One Streamy already knows (its data is in the video
 * folder, or the library has it) may open: nothing downloads while the
 * disk is low anyway, and watching what's already downloaded still works.
 */
export function admitTorrent(_infoHash: string, known: boolean): void {
  if (engineServices()?.cachePolicy.isClearing()) {
    throw new AppError(ErrorCode.ServiceUnavailable, CLEARING_MESSAGE);
  }
  if (!known) assertEnoughDiskSpace();
}
