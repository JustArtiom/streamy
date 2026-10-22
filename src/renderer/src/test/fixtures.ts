import type {
  ContinueWatchingItem,
  Health,
  Library,
  LibraryTorrent,
  TorrentDetail,
  TorrentFile,
} from "../../../shared/engine-api";

// Example engine answers for UI tests. Override what a test cares about.

export const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
export const OTHER_HASH = "b".repeat(40);

export function torrentFile(
  index: number,
  name: string,
  kind: TorrentFile["kind"] = "video",
  overrides: Partial<TorrentFile> = {},
): TorrentFile {
  return {
    index,
    name,
    path: `Sintel/${name}`,
    size: 1_000_000,
    kind,
    progress: 0,
    ...overrides,
  };
}

export function torrentDetail(
  overrides: Partial<TorrentDetail> = {},
): TorrentDetail {
  const now = new Date().toISOString();
  return {
    infoHash: HASH,
    name: "Sintel",
    status: "ready",
    error: null,
    size: 129_241_752,
    progress: 0.1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    peers: 3,
    addedAt: now,
    lastActivityAt: now,
    files: [
      torrentFile(0, "Sintel.mp4", "video"),
      torrentFile(1, "Sintel.en.srt", "subtitle"),
    ],
    ...overrides,
  };
}

export function libraryTorrent(
  overrides: Partial<LibraryTorrent> = {},
): LibraryTorrent {
  return {
    infoHash: HASH,
    name: "Sintel",
    size: 129_241_752,
    addedAt: "2026-10-20T10:00:00.000Z",
    lastOpenedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    active: false,
    ...overrides,
  };
}

export function continueItem(
  overrides: Partial<ContinueWatchingItem> = {},
): ContinueWatchingItem {
  return {
    infoHash: HASH,
    fileIndex: 0,
    fileName: "Sintel.mp4",
    position: 300,
    duration: 1_020,
    audioTrack: null,
    subtitle: null,
    watched: false,
    updatedAt: new Date().toISOString(),
    torrentName: "Sintel",
    thumbnailUrl: null,
    ...overrides,
  };
}

export function library(overrides: Partial<Library> = {}): Library {
  return { continueWatching: [], recent: [], ...overrides };
}

export function health(overrides: Partial<Health> = {}): Health {
  return {
    version: "0.1.0",
    uptime: 10,
    ffmpeg: { version: "8.1.3-Jellyfin", error: null },
    encoder: "h264_videotoolbox",
    lowDiskSpace: false,
    ...overrides,
  };
}
