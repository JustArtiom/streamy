import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { CacheUsage } from "../../shared/settings";
import { CACHE_CONTENT_DIRS, CACHE_MARKER } from "../../shared/video-folder";
import { isErrnoCode } from "../storage/json-file";

export { CACHE_CONTENT_DIRS, CACHE_MARKER };

// Where videos are kept while watching. They can always be downloaded again,
// so by default they go in the OS cache folder: it isn't synced to the cloud
// or backed up (unlike the app's data folder).
//
// Safety rules, so Streamy never deletes the user's own files:
// - Streamy only writes into its own subfolders (CACHE_CONTENT_DIRS), and
//   clearing the cache deletes those and nothing else.
// - It only uses a chosen folder directly if it's brand new, truly empty, or
//   already Streamy's. Otherwise (and always for Downloads, Desktop, a drive
//   root…) it makes a "Streamy" folder inside it.

const MARKER_TEXT =
  "Streamy keeps the videos you watch in this folder.\n" +
  "It only ever deletes what it downloaded itself (the torrents, playback and subtitles folders).\n";

/** Made inside a chosen folder that Streamy shouldn't take over. */
export const CACHE_SUBFOLDER = "Streamy";

/** Files the OS creates by itself; they don't make a folder "in use". */
const SYSTEM_FILES = new Set([
  ".DS_Store",
  ".localized",
  "Thumbs.db",
  "desktop.ini",
]);

/** A folder Streamy can't use. The message is meant for the user. */
export class CacheDirError extends Error {
  override name = "CacheDirError";
}

interface DefaultCacheDirOptions {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** Folder name, e.g. "Streamy" (or "Streamy Dev" for dev builds). */
  name: string;
}

export function defaultCacheDir({
  platform,
  home,
  env,
  name,
}: DefaultCacheDirOptions): string {
  if (platform === "win32") {
    // Local, not Roaming: a video cache must never sync between computers.
    const local = env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, name, "Cache");
  }
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Caches", name);
  }
  const xdg = env.XDG_CACHE_HOME;
  const base =
    xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, ".cache");
  return path.posix.join(base, name.toLowerCase().replaceAll(" ", "-"));
}

/** Same folder? (macOS and Windows ignore upper/lower case.) */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "linux" ? resolved : resolved.toLowerCase();
  };
  return normalize(a) === normalize(b);
}

/**
 * Drive roots, macOS volumes and the user's own folders (Downloads…): never
 * used directly, Streamy makes its own folder inside them instead.
 */
export function isProtectedFolder(
  dir: string,
  protectedDirs: string[],
): boolean {
  const resolved = path.resolve(dir);
  return (
    resolved === path.parse(resolved).root ||
    path.dirname(resolved) === "/Volumes" ||
    protectedDirs.some((protectedDir) => samePath(protectedDir, resolved))
  );
}

type FolderState = "missing" | "empty" | "ours" | "in-use" | "unreadable";

function inspect(dir: string): FolderState {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    return isErrnoCode(error, "ENOENT") ? "missing" : "unreadable";
  }
  if (entries.includes(CACHE_MARKER)) return "ours";
  return entries.every((entry) => SYSTEM_FILES.has(entry)) ? "empty" : "in-use";
}

function markAsCache(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, CACHE_MARKER);
  if (!existsSync(marker)) writeFileSync(marker, MARKER_TEXT);
}

const CANT_OPEN = "Streamy can't open that folder. Choose a different one.";
const CANT_WRITE =
  "Streamy can't save files in that folder. Choose a different one.";

interface PrepareOptions {
  /** Folders Streamy must never use directly (home, Downloads, Desktop…). */
  protectedDirs: string[];
}

/** Turns the folder the user picked into the folder Streamy will use. */
export function prepareCacheDir(
  chosen: string,
  { protectedDirs }: PrepareOptions,
): string {
  if (!path.isAbsolute(chosen)) {
    throw new CacheDirError("Choose a folder on this computer.");
  }

  const state = inspect(chosen);
  if (state === "unreadable") throw new CacheDirError(CANT_OPEN);
  const useDirectly =
    state === "ours" ||
    ((state === "missing" || state === "empty") &&
      !isProtectedFolder(chosen, protectedDirs));

  let dir = chosen;
  if (!useDirectly) {
    dir = path.join(chosen, CACHE_SUBFOLDER);
    const subfolderState = inspect(dir);
    if (subfolderState === "unreadable") {
      throw new CacheDirError(
        `Streamy can't use the "${CACHE_SUBFOLDER}" item in ${chosen}. Choose a different folder.`,
      );
    }
    if (subfolderState === "in-use") {
      throw new CacheDirError(
        `There's already a "${CACHE_SUBFOLDER}" folder with other files in ${chosen}. Choose a different folder.`,
      );
    }
  }

  try {
    markAsCache(dir);
  } catch {
    throw new CacheDirError(CANT_WRITE);
  }
  return dir;
}

/** The default folder is always Streamy's own: create it if needed. */
export function ensureDefaultCacheDir(dir: string): void {
  markAsCache(dir);
}

/** Disk space used by Streamy's videos (only its own subfolders). */
export async function cacheUsage(dir: string): Promise<CacheUsage> {
  if (!existsSync(dir)) return { status: "missing" };
  let bytes = 0;
  for (const name of CACHE_CONTENT_DIRS) {
    bytes += await folderSize(path.join(dir, name));
  }
  return { status: "ok", bytes };
}

async function folderSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await folderSize(full);
    } else if (entry.isFile()) {
      try {
        const stats = await lstat(full);
        // Space really used on disk: a half-downloaded torrent file may be
        // "4 GB" long but only take what has been downloaded so far.
        total += stats.blocks > 0 ? stats.blocks * 512 : stats.size;
      } catch {
        // Deleted while counting: skip it.
      }
    }
    // Links aren't followed: they point outside the cache.
  }
  return total;
}

/**
 * Deletes Streamy's downloaded videos. Refuses to touch a folder that isn't
 * marked as Streamy's, and never deletes anything outside its own subfolders.
 */
export async function clearCache(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  if (!existsSync(path.join(dir, CACHE_MARKER))) {
    throw new CacheDirError(
      "This doesn't look like Streamy's video folder, so nothing was deleted.",
    );
  }
  for (const name of CACHE_CONTENT_DIRS) {
    await rm(path.join(dir, name), {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}
