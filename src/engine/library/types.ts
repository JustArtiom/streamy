// The library: what Streamy remembers between launches (torrents you opened,
// how far you watched each file). The rest of the engine depends only on the
// `LibraryStore` interface below, never on SQLite, so the storage can be
// swapped (e.g. for a JSON file, PLAN §4.6) without touching callers.
//
// Times are milliseconds since 1970 (what Date.now() returns). The mappers in
// ./mappers.ts turn entries into the API's types (ISO dates).

/**
 * Where the library's log lines go. Shaped like pino (`logger.warn(obj, msg)`),
 * so the engine's logger can be passed as is.
 */
export interface LibraryLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

/** A torrent the library knows. Lists leave out the (possibly large) metadata. */
export interface TorrentEntry {
  /** 40 lowercase hex characters. */
  infoHash: string;
  name: string;
  /** The magnet link it was added with, if any. */
  magnet: string | null;
  /** Bytes of all files. null until the metadata is known. */
  totalSize: number | null;
  /** The .torrent is saved, so it can be re-opened without peers. */
  hasMetadata: boolean;
  addedAt: number;
  lastOpenedAt: number;
}

export interface TorrentEntryWithMetadata extends TorrentEntry {
  /** The .torrent file's bytes (pass to WebTorrent to re-open it instantly). */
  metadata: Buffer | null;
}

/** How far one file was watched. */
export interface ProgressEntry {
  infoHash: string;
  fileIndex: number;
  fileName: string;
  /** Seconds. */
  position: number;
  /** Seconds. null until known. */
  duration: number | null;
  /** AudioTrack.index, null = the file's default. */
  audioTrack: number | null;
  /** SubtitleTrack.id, null = off. */
  subtitle: string | null;
  watched: boolean;
  updatedAt: number;
}

export interface ContinueWatchingEntry extends ProgressEntry {
  torrentName: string;
}

export interface RecordTorrentInput {
  infoHash: string;
  /**
   * The torrent's name. null = not known yet (a magnet without a name): keeps
   * the saved name, or uses the info hash for a new entry.
   */
  name: string | null;
  /** Omitted or null keeps what's saved: never erased once known. */
  magnet?: string | null;
  /** The .torrent bytes. Omitted or null keeps what's saved. */
  metadata?: Uint8Array | null;
  /** Omitted or null keeps what's saved. */
  totalSize?: number | null;
}

export interface SaveProgressInput {
  infoHash: string;
  fileIndex: number;
  fileName: string;
  /** Seconds, finite and ≥ 0. */
  position: number;
  /**
   * Seconds, finite and ≥ 0. null = not known right now: keeps the saved
   * duration (a file's length doesn't change).
   */
  duration: number | null;
  /** Omitted = keep what's saved. null = the file's default track. */
  audioTrack?: number | null;
  /** Omitted = keep what's saved. null = subtitles off. */
  subtitle?: string | null;
  /** Omitted = decided by the watched rule (./rules.ts). */
  watched?: boolean;
}

/**
 * Everything the engine can do with the library. All calls are synchronous
 * and quick (small tables, prepared statements). They throw `LibraryError`
 * for bad input, unknown torrents and a closed library.
 */
export interface LibraryStore {
  /** false for the in-memory fallback: nothing survives a restart. */
  readonly persistent: boolean;

  /**
   * Adds a torrent, or refreshes one already known (keeps `addedAt`).
   * Either way `lastOpenedAt` becomes now.
   */
  recordTorrent(input: RecordTorrentInput): TorrentEntry;
  /** Sets `lastOpenedAt` to now. false if the torrent isn't known. */
  touchTorrent(infoHash: string): boolean;
  /** One torrent, with its metadata, or null if it isn't known. */
  getTorrent(infoHash: string): TorrentEntryWithMetadata | null;
  /** Most recently opened first (default RECENT_LIMIT). */
  listRecent(limit?: number): TorrentEntry[];
  /** Every file of the torrent with a saved position, by file index. */
  getProgress(infoHash: string): ProgressEntry[];
  getFileProgress(infoHash: string, fileIndex: number): ProgressEntry | null;
  /**
   * Saves a position. The torrent must be recorded first, else this throws
   * `LibraryError` with code "not_found".
   */
  saveProgress(input: SaveProgressInput): ProgressEntry;
  /**
   * Files not watched, past the first 30 s, newest first (default
   * CONTINUE_WATCHING_LIMIT).
   */
  listContinueWatching(limit?: number): ContinueWatchingEntry[];
  /** Forgets one file's position and its thumbnail. false if none was saved. */
  deleteProgress(infoHash: string, fileIndex: number): boolean;
  /** Forgets a torrent, its positions and thumbnails. false if it wasn't known. */
  forgetTorrent(infoHash: string): boolean;
  /**
   * Where the thumbnail for this file lives (it may not exist). The library
   * deletes it with the file's progress; making it is up to the caller.
   */
  thumbnailPath(infoHash: string, fileIndex: number): string;
  /** Closes the database. Safe to call twice; any other call then throws. */
  close(): void;
}

export type LibraryErrorCode =
  /** The torrent isn't in the library (the API answers 404). */
  | "not_found"
  /** A value failed validation, e.g. a NaN position (the API answers 400). */
  | "invalid_input"
  /** close() was called. */
  | "closed"
  /** library.db is from a newer Streamy. It was left untouched. */
  | "newer_version"
  /**
   * library.db exists but can't be opened or written right now (no
   * permission, read-only disk, locked). It was left untouched.
   */
  | "unavailable";

export class LibraryError extends Error {
  override name = "LibraryError";
  readonly code: LibraryErrorCode;
  /** For "invalid_input": the field at fault, e.g. "position". */
  readonly field: string | undefined;

  constructor(
    code: LibraryErrorCode,
    message: string,
    options: { field?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    this.field = options.field;
  }
}
