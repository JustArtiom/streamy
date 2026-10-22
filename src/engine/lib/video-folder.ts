import { mkdir } from "node:fs/promises";
import { cacheDirState } from "../cache";
import { type CachePaths, cachePaths, getRuntime } from "../config";
import { AppError, ErrorCode } from "../http/errors";

/*
 * The video folder (cacheDir) is made by main, with a ".streamy-cache"
 * marker in it. The engine never creates the folder itself: if it's missing
 * (an external drive was unplugged), creating it would quietly fill the
 * boot disk under /Volumes/… instead. The engine only makes its own
 * subfolders (torrents/, playback/, subtitles/) inside a folder that is
 * there and marked. The check itself is cacheDirState (cache/layout.ts).
 */

export const VIDEO_FOLDER_UNAVAILABLE =
  "The video folder isn't available. Is the drive connected?";

/** mkdir without `recursive`: the parent must already be there. */
export async function makeDirIn(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Before writing anything: checks the folder and makes our subfolders.
 * Throws 503 SERVICE_UNAVAILABLE when the folder isn't there or isn't
 * Streamy's (or can't even be looked at).
 */
export async function ensureVideoFolder(
  cacheDir: string = getRuntime().config.cacheDir,
): Promise<CachePaths> {
  const state = await cacheDirState(cacheDir).catch(() => "unreadable");
  if (state !== "ok") {
    throw new AppError(ErrorCode.ServiceUnavailable, VIDEO_FOLDER_UNAVAILABLE);
  }
  const paths = cachePaths(cacheDir);
  await Promise.all(
    [paths.torrents, paths.playback, paths.subtitles].map(makeDirIn),
  );
  return paths;
}
