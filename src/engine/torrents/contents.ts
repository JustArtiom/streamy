import { isAbsolute } from "node:path";
import type { TorrentInfo } from "webtorrent";
import { MAX_TORRENT_FILES } from "../config";

/*
 * Is a torrent's file list safe to write to disk? A torrent names its own
 * files, so a hostile (or just odd) one could:
 * - climb out of its folder ("../../.bashrc", "/etc/x", "C:\x");
 * - name two files that end up as one file on disk, so the second one's
 *   pieces overwrite the first one's verified data. "Subs.srt" and
 *   "subs.srt" are one file on macOS and Windows; "a?.mkv" and "a*.mkv" are
 *   one file everywhere, because the store (fs-chunk-store) strips
 *   <>:"/\|?* and control characters from file names;
 * - use names Windows treats specially: devices (CON, NUL.txt, COM1…),
 *   names ending in a dot or space (Windows drops those, another
 *   collision), ":" (alternate data streams).
 * Windows' rules apply on every OS: the same video folder can be on a
 * drive used from Windows, and one rule set is easier to trust.
 */

export const UNSAFE_NAMES_MESSAGE =
  "This torrent has file names Streamy can't save safely.";

/** What the store strips from file names (fs-chunk-store 5). */
// eslint-disable-next-line no-control-regex
const STRIPPED_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
/** Windows device names, with or without an extension, any case. */
const DEVICE_NAME =
  /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

function isDeviceName(component: string): boolean {
  const stem = component.split(".", 1)[0] ?? "";
  return DEVICE_NAME.test(stem.trimEnd());
}

/** One folder or file name as the torrent declares it. */
function isUnsafeComponent(component: string): boolean {
  return (
    component === ".." ||
    component.includes(":") ||
    CONTROL_CHARS.test(component) ||
    // "." alone is fine (path.join drops it); "a." and "a " aren't.
    (component !== "." && /[. ]$/.test(component)) ||
    isDeviceName(component)
  );
}

/** Absolute, climbing out of its folder, or a name Windows can't keep. */
export function isUnsafePath(path: string): boolean {
  return (
    isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    path.split(/[\\/]/).some(isUnsafeComponent)
  );
}

/**
 * The name a component really gets on disk, folded the way a
 * case-insensitive disk compares names: stripped like the store does,
 * without the trailing dots and spaces Windows drops, one Unicode form
 * (macOS doesn't tell é from e+◌́), one case (ß and SS too).
 */
function onDiskKey(component: string): string {
  return component
    .replace(STRIPPED_CHARS, "")
    .replace(/[. ]+$/, "")
    .normalize("NFC")
    .toUpperCase()
    .toLowerCase();
}

/**
 * Two files that would be one on disk, a file where another file needs a
 * folder, or a name that is nothing (or a device) once stripped.
 */
export function hasCollidingPaths(paths: string[]): boolean {
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path
      .split(/[\\/]/)
      .filter((part) => part !== "" && part !== ".")
      .map(onDiskKey);
    if (parts.length === 0) return true;
    if (parts.some((part) => part === "" || isDeviceName(part))) return true;

    const file = parts.join("/");
    if (files.has(file) || folders.has(file)) return true;
    files.add(file);
    for (let end = 1; end < parts.length; end++) {
      const folder = parts.slice(0, end).join("/");
      if (files.has(folder)) return true;
      folders.add(folder);
    }
  }
  return false;
}

/** The paths a torrent's raw `info` declares ("Name/dir/file.mkv"). */
export function rawPaths(info: TorrentInfo | undefined): string[] {
  if (!info) return [];
  const decoder = new TextDecoder();
  const text = (bytes: Uint8Array | undefined) =>
    bytes ? decoder.decode(bytes) : "";

  const name = text(info["name.utf-8"] ?? info.name);
  const files = (info.files ?? []).map((file) =>
    [name, ...(file["path.utf-8"] ?? file.path ?? []).map(text)].join("/"),
  );
  return [name, ...files];
}

/**
 * Why a torrent can't be opened, or null if it's fine. WebTorrent quietly
 * normalises paths (dropping ".."), so the raw names the torrent declared
 * are checked too: a torrent that tries this is hostile.
 */
export function torrentContentsProblem(contents: {
  /** Each file's path as WebTorrent writes it (`files[].path`). */
  files: string[];
  /** The raw `info` dictionary, if known. */
  info: TorrentInfo | undefined;
}): string | null {
  const { files, info } = contents;
  if (files.length > MAX_TORRENT_FILES) {
    return `This torrent has too many files (${files.length.toLocaleString("en-US")}). Streamy opens torrents with up to ${MAX_TORRENT_FILES.toLocaleString("en-US")} files.`;
  }
  if (
    [...files, ...rawPaths(info)].some(isUnsafePath) ||
    hasCollidingPaths(files)
  ) {
    return UNSAFE_NAMES_MESSAGE;
  }
  return null;
}
