import type {
  ContinueWatchingItem,
  FileProgress,
  Library,
  LibraryTorrent,
  LibraryTorrentDetail,
} from "../../shared/engine-api";
import type {
  ContinueWatchingEntry,
  ProgressEntry,
  TorrentEntry,
} from "./types";

// From library entries to the API's types (src/shared/engine-api.ts): ISO
// dates instead of milliseconds, and nothing the API doesn't promise (no
// magnet, no metadata). Whether a torrent is active and whether a thumbnail
// exists aren't stored in the library: the caller knows, and passes them in.

function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}

/** The URL the API serves a file's thumbnail at. */
export function thumbnailUrl(infoHash: string, fileIndex: number): string {
  return `/v1/library/${infoHash}/files/${fileIndex}/thumbnail`;
}

export function toLibraryTorrent(
  entry: TorrentEntry,
  active: boolean,
): LibraryTorrent {
  return {
    infoHash: entry.infoHash,
    name: entry.name,
    size: entry.totalSize,
    addedAt: isoDate(entry.addedAt),
    lastOpenedAt: isoDate(entry.lastOpenedAt),
    active,
  };
}

export function toFileProgress(entry: ProgressEntry): FileProgress {
  return {
    infoHash: entry.infoHash,
    fileIndex: entry.fileIndex,
    fileName: entry.fileName,
    position: entry.position,
    duration: entry.duration,
    audioTrack: entry.audioTrack,
    subtitle: entry.subtitle,
    watched: entry.watched,
    updatedAt: isoDate(entry.updatedAt),
  };
}

export function toContinueWatchingItem(
  entry: ContinueWatchingEntry,
  thumbnail: string | null,
): ContinueWatchingItem {
  return {
    ...toFileProgress(entry),
    torrentName: entry.torrentName,
    thumbnailUrl: thumbnail,
  };
}

/** What only the running engine knows. */
export interface RuntimeState {
  /** Running in the torrent client right now. */
  isActive(infoHash: string): boolean;
  /** The thumbnail URL once one exists (see thumbnailUrl()), else null. */
  thumbnailUrlFor(entry: ProgressEntry): string | null;
}

/** GET /v1/library */
export function toLibrary(
  lists: { continueWatching: ContinueWatchingEntry[]; recent: TorrentEntry[] },
  runtime: RuntimeState,
): Library {
  return {
    continueWatching: lists.continueWatching.map((entry) =>
      toContinueWatchingItem(entry, runtime.thumbnailUrlFor(entry)),
    ),
    recent: lists.recent.map((entry) =>
      toLibraryTorrent(entry, runtime.isActive(entry.infoHash)),
    ),
  };
}

/** GET /v1/library/:infoHash */
export function toLibraryTorrentDetail(
  torrent: TorrentEntry,
  progress: ProgressEntry[],
  active: boolean,
): LibraryTorrentDetail {
  return {
    torrent: toLibraryTorrent(torrent, active),
    progress: progress.map(toFileProgress),
  };
}
