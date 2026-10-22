import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  LATEST_VERSION,
  migrate,
  newerVersionError,
  readUserVersion,
} from "./migrations";
import {
  CONTINUE_WATCHING_LIMIT,
  CONTINUE_WATCHING_MIN_POSITION,
  decideWatched,
  RECENT_LIMIT,
} from "./rules";
import { removeThumbnail, thumbnailFile, thumbnailFolder } from "./thumbnails";
import {
  type ContinueWatchingEntry,
  LibraryError,
  type LibraryLogger,
  type LibraryStore,
  type ProgressEntry,
  type RecordTorrentInput,
  type SaveProgressInput,
  type TorrentEntry,
  type TorrentEntryWithMetadata,
} from "./types";
import {
  checkBoolean,
  checkBytes,
  checkIndex,
  checkInfoHash,
  checkLimit,
  checkSeconds,
  checkText,
  optional,
} from "./validate";

// library.db on node:sqlite (SQLite 3.53 built into Node 24; no native
// add-on to ship). Node 24.21 and Electron 45's Node 24.22 print no
// ExperimentalWarning for it (checked with process.on("warning")), even
// though the docs still call it "active development". If that changes, the
// warning is harmless and should not be silenced globally.
//
// Settings chosen on open:
// - journal_mode=WAL: a save never blocks a read, and a crash mid-save can't
//   damage the file.
// - synchronous=NORMAL: with WAL, still crash-proof; a power cut may lose the
//   last few seconds of saves. Fine for positions saved every 5 s, and it
//   spares the disk a flush on every heartbeat (FULL would).
// - foreign_keys=ON: forgetting a torrent removes its positions (CASCADE).
// - busy timeout 2 s: see BUSY_TIMEOUT_MS.

/**
 * How long a write waits for another connection's lock before failing (ms).
 * Only the engine opens library.db, so waits are rare (a database browser
 * left open, an old engine still shutting down). Kept short because
 * node:sqlite waits synchronously: the whole engine, HTTP included, stalls
 * while it waits.
 */
const BUSY_TIMEOUT_MS = 2000;

/** SQLite result codes meaning "this file is damaged" (sqlite.org/rescode.html). */
const DAMAGED_CODES = new Set([
  11, // SQLITE_CORRUPT
  26, // SQLITE_NOTADB
]);

/** Files SQLite keeps next to a database. They belong to it and move with it. */
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

export interface OpenLibraryOptions {
  logger: LibraryLogger;
  /** The clock, in ms since 1970. Tests pass a fake one. */
  now?: () => number;
  /** Where thumbnails go. Default: "thumbnails" next to library.db. */
  thumbnailsDir?: string;
}

export interface InMemoryLibraryOptions extends OpenLibraryOptions {
  thumbnailsDir: string;
}

/**
 * Opens (or creates) library.db and brings it up to date.
 *
 * - A damaged file is moved aside to `library.db.corrupt-<time>` (kept, so it
 *   can be rescued by hand) and a fresh library starts, with a warning.
 * - A file from a newer Streamy throws `LibraryError` "newer_version": its
 *   layout is unknown here, so even reading it could go wrong, and writing
 *   could damage it. Refusing keeps it intact for when that newer version
 *   runs again.
 * - A file that can't be opened or written right now (no permission,
 *   read-only disk, locked) throws "unavailable". It's probably fine, so
 *   moving it aside would hide the history for nothing.
 *
 * The engine must start anyway: on a throw, log it and use
 * openInMemoryLibrary().
 */
export function openLibrary(
  file: string,
  options: OpenLibraryOptions,
): LibraryStore {
  const { logger, now = Date.now } = options;
  const thumbnailsDir =
    options.thumbnailsDir ?? join(dirname(file), "thumbnails");

  let db: DatabaseSync;
  try {
    mkdirSync(dirname(file), { recursive: true });
    db = openFile(file, logger);
  } catch (error) {
    if (!isDamaged(error)) throw asLibraryError(file, error);
    try {
      const backup = moveAside(file, Math.trunc(now()));
      logger.warn(
        { err: error, file, backup },
        "library.db was damaged: moved it aside and started a fresh library",
      );
      db = openFile(file, logger);
    } catch (recoveryError) {
      throw asLibraryError(file, recoveryError);
    }
  }
  return new SqliteLibrary(db, {
    logger,
    now,
    thumbnailsDir,
    persistent: true,
  });
}

/**
 * A library kept in memory only: the fallback when library.db can't be used
 * (and handy in tests). Everything works; nothing survives a restart.
 */
export function openInMemoryLibrary(
  options: InMemoryLibraryOptions,
): LibraryStore {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return new SqliteLibrary(db, {
    logger: options.logger,
    now: options.now ?? Date.now,
    thumbnailsDir: options.thumbnailsDir,
    persistent: false,
  });
}

// ─── Opening ─────────────────────────────────────────────────────────────────

/** Damage found by PRAGMA quick_check. */
class DamagedDatabaseError extends Error {
  override name = "DamagedDatabaseError";
}

function openFile(file: string, logger: LibraryLogger): DatabaseSync {
  const db = new DatabaseSync(file, {
    timeout: BUSY_TIMEOUT_MS,
    enableForeignKeyConstraints: true,
  });
  try {
    checkIntegrity(db);
    // Before anything below writes to the file.
    const version = readUserVersion(db);
    if (version > LATEST_VERSION) {
      throw newerVersionError(version, LATEST_VERSION);
    }
    useWriteAheadLog(db, logger);
    const { from, to } = migrate(db);
    if (from !== to) {
      logger.info(
        { file, from, to },
        from === 0 ? "Created library.db" : "Upgraded library.db",
      );
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Reading the header (user_version) only notices a file that isn't a
 * database at all. quick_check walks the whole file and finds damaged pages
 * too. It's quick: about 10 ms for 100 MB.
 */
function checkIntegrity(db: DatabaseSync): void {
  const results = db
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => row.quick_check);
  if (results.length === 1 && results[0] === "ok") return;
  const problems = results.filter((result) => typeof result === "string");
  throw new DamagedDatabaseError(
    `quick_check: ${problems.slice(0, 3).join("; ")}`,
  );
}

function useWriteAheadLog(db: DatabaseSync, logger: LibraryLogger): void {
  const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
  if (mode === "wal") {
    db.exec("PRAGMA synchronous = NORMAL");
    return;
  }
  // Some network drives can't do WAL. Without it, only FULL is safe from
  // power cuts.
  logger.warn(
    { mode },
    "library.db can't use write-ahead logging here: saving more carefully instead",
  );
  db.exec("PRAGMA synchronous = FULL");
}

function isDamaged(error: unknown): boolean {
  if (error instanceof DamagedDatabaseError) return true;
  const code =
    error instanceof Error && "errcode" in error ? error.errcode : undefined;
  // Extended result codes keep the primary code in the low byte.
  return typeof code === "number" && DAMAGED_CODES.has(code & 0xff);
}

/**
 * Renames a damaged database to `<file>.corrupt-<time>`, its sidecar files
 * first: a fresh database must never pick up the old one's write-ahead log
 * (SQLite would replay it into the new file). SQLite usually deletes them
 * itself when it notices the damage; this covers the times it can't. If any
 * rename fails, this throws and the main file stays where it is.
 *
 * Exported for tests.
 */
export function moveAside(file: string, time: number): string {
  let backup = `${file}.corrupt-${time}`;
  for (let n = 2; existsSync(backup); n++) {
    backup = `${file}.corrupt-${time}-${n}`;
  }
  for (const suffix of SIDECAR_SUFFIXES) {
    renameIfExists(file + suffix, backup + suffix);
  }
  renameSync(file, backup);
  return backup;
}

function renameIfExists(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function asLibraryError(file: string, error: unknown): LibraryError {
  if (error instanceof LibraryError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new LibraryError(
    "unavailable",
    `library.db can't be used (${file}): ${reason}`,
    { cause: error },
  );
}

// ─── Rows ────────────────────────────────────────────────────────────────────

const TORRENT_COLUMNS = `info_hash, name, magnet, total_size,
  metadata IS NOT NULL AS has_metadata, added_at, last_opened_at`;

const PROGRESS_COLUMNS = `info_hash, file_index, file_name, position, duration,
  audio_track, subtitle, watched, updated_at`;

// Rows are checked as they come out, so a surprise (a bug, a hand-edited
// file) fails loudly instead of spreading wrong types through the engine.
const torrentRow = z.object({
  info_hash: z.string(),
  name: z.string(),
  magnet: z.string().nullable(),
  total_size: z.number().nullable(),
  has_metadata: z.number(),
  added_at: z.number(),
  last_opened_at: z.number(),
});

const torrentRowWithMetadata = torrentRow.extend({
  metadata: z.instanceof(Uint8Array).nullable(),
});

const progressRow = z.object({
  info_hash: z.string(),
  file_index: z.number(),
  file_name: z.string(),
  position: z.number(),
  duration: z.number().nullable(),
  audio_track: z.number().nullable(),
  subtitle: z.string().nullable(),
  watched: z.number(),
  updated_at: z.number(),
});

const continueWatchingRow = progressRow.extend({ torrent_name: z.string() });

function toTorrentEntry(row: z.infer<typeof torrentRow>): TorrentEntry {
  return {
    infoHash: row.info_hash,
    name: row.name,
    magnet: row.magnet,
    totalSize: row.total_size,
    hasMetadata: row.has_metadata !== 0,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function toProgressEntry(row: z.infer<typeof progressRow>): ProgressEntry {
  return {
    infoHash: row.info_hash,
    fileIndex: row.file_index,
    fileName: row.file_name,
    position: row.position,
    duration: row.duration,
    audioTrack: row.audio_track,
    subtitle: row.subtitle,
    watched: row.watched !== 0,
    updatedAt: row.updated_at,
  };
}

/** A view of the same bytes as a Buffer (no copy). */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function prepareStatements(db: DatabaseSync) {
  return {
    // A known torrent keeps added_at, and never loses what's known about it
    // (magnet, metadata, size) to a null.
    upsertTorrent: db.prepare(`
      INSERT INTO torrents
        (info_hash, name, magnet, metadata, total_size, added_at, last_opened_at)
      VALUES (:infoHash, :name, :magnet, :metadata, :totalSize, :now, :now)
      ON CONFLICT (info_hash) DO UPDATE SET
        name = COALESCE(:givenName, name),
        magnet = COALESCE(excluded.magnet, magnet),
        metadata = COALESCE(excluded.metadata, metadata),
        total_size = COALESCE(excluded.total_size, total_size),
        last_opened_at = excluded.last_opened_at
      RETURNING ${TORRENT_COLUMNS}`),
    touchTorrent: db.prepare(
      "UPDATE torrents SET last_opened_at = :now WHERE info_hash = :infoHash",
    ),
    getTorrent: db.prepare(
      `SELECT ${TORRENT_COLUMNS}, metadata FROM torrents WHERE info_hash = ?`,
    ),
    torrentExists: db.prepare(
      "SELECT 1 AS found FROM torrents WHERE info_hash = ?",
    ),
    listRecent: db.prepare(`
      SELECT ${TORRENT_COLUMNS} FROM torrents
      ORDER BY last_opened_at DESC, info_hash
      LIMIT ?`),
    deleteTorrent: db.prepare("DELETE FROM torrents WHERE info_hash = ?"),
    getProgress: db.prepare(`
      SELECT ${PROGRESS_COLUMNS} FROM progress
      WHERE info_hash = ?
      ORDER BY file_index`),
    getFileProgress: db.prepare(`
      SELECT ${PROGRESS_COLUMNS} FROM progress
      WHERE info_hash = ? AND file_index = ?`),
    upsertProgress: db.prepare(`
      INSERT INTO progress (${PROGRESS_COLUMNS})
      VALUES (:infoHash, :fileIndex, :fileName, :position, :duration,
              :audioTrack, :subtitle, :watched, :updatedAt)
      ON CONFLICT (info_hash, file_index) DO UPDATE SET
        file_name = excluded.file_name,
        position = excluded.position,
        duration = excluded.duration,
        audio_track = excluded.audio_track,
        subtitle = excluded.subtitle,
        watched = excluded.watched,
        updated_at = excluded.updated_at
      RETURNING ${PROGRESS_COLUMNS}`),
    // Ties (same millisecond) are broken by torrent and file, so the order
    // never flickers between two requests.
    continueWatching: db.prepare(`
      SELECT ${PROGRESS_COLUMNS}, torrents.name AS torrent_name
      FROM progress JOIN torrents USING (info_hash)
      WHERE watched = 0 AND position > :minPosition
      ORDER BY updated_at DESC, info_hash, file_index
      LIMIT :limit`),
    deleteProgress: db.prepare(
      "DELETE FROM progress WHERE info_hash = ? AND file_index = ?",
    ),
  };
}

// ─── The library ─────────────────────────────────────────────────────────────

interface LibraryContext {
  logger: LibraryLogger;
  now: () => number;
  thumbnailsDir: string;
  persistent: boolean;
}

class SqliteLibrary implements LibraryStore {
  readonly persistent: boolean;
  readonly #db: DatabaseSync;
  readonly #sql: ReturnType<typeof prepareStatements>;
  readonly #logger: LibraryLogger;
  readonly #now: () => number;
  readonly #thumbnailsDir: string;
  #closed = false;

  constructor(db: DatabaseSync, context: LibraryContext) {
    this.#db = db;
    this.#sql = prepareStatements(db);
    this.#logger = context.logger;
    this.#now = context.now;
    this.#thumbnailsDir = context.thumbnailsDir;
    this.persistent = context.persistent;
  }

  recordTorrent(input: RecordTorrentInput): TorrentEntry {
    this.#assertOpen();
    const infoHash = checkInfoHash(input.infoHash);
    const name = optional(input.name, (v) => checkText(v, "name")) ?? null;
    const row = this.#sql.upsertTorrent.get({
      infoHash,
      name: name ?? infoHash,
      givenName: name,
      magnet: optional(input.magnet, (v) => checkText(v, "magnet")) ?? null,
      metadata:
        optional(input.metadata, (v) => checkBytes(v, "metadata")) ?? null,
      totalSize:
        optional(input.totalSize, (v) => checkIndex(v, "totalSize")) ?? null,
      now: this.#timestamp(),
    });
    return toTorrentEntry(torrentRow.parse(row));
  }

  touchTorrent(infoHash: string): boolean {
    this.#assertOpen();
    const { changes } = this.#sql.touchTorrent.run({
      infoHash: checkInfoHash(infoHash),
      now: this.#timestamp(),
    });
    return Number(changes) > 0;
  }

  getTorrent(infoHash: string): TorrentEntryWithMetadata | null {
    this.#assertOpen();
    const row = this.#sql.getTorrent.get(checkInfoHash(infoHash));
    if (row === undefined) return null;
    const parsed = torrentRowWithMetadata.parse(row);
    return {
      ...toTorrentEntry(parsed),
      metadata: parsed.metadata && asBuffer(parsed.metadata),
    };
  }

  listRecent(limit: number = RECENT_LIMIT): TorrentEntry[] {
    this.#assertOpen();
    return this.#sql.listRecent
      .all(checkLimit(limit))
      .map((row) => toTorrentEntry(torrentRow.parse(row)));
  }

  getProgress(infoHash: string): ProgressEntry[] {
    this.#assertOpen();
    return this.#sql.getProgress
      .all(checkInfoHash(infoHash))
      .map((row) => toProgressEntry(progressRow.parse(row)));
  }

  getFileProgress(infoHash: string, fileIndex: number): ProgressEntry | null {
    this.#assertOpen();
    const row = this.#sql.getFileProgress.get(
      checkInfoHash(infoHash),
      checkIndex(fileIndex, "fileIndex"),
    );
    return row === undefined ? null : toProgressEntry(progressRow.parse(row));
  }

  saveProgress(input: SaveProgressInput): ProgressEntry {
    this.#assertOpen();
    const infoHash = checkInfoHash(input.infoHash);
    const fileIndex = checkIndex(input.fileIndex, "fileIndex");
    const fileName = checkText(input.fileName, "fileName");
    const position = checkSeconds(input.position, "position");
    const duration = optional(input.duration, (v) =>
      checkSeconds(v, "duration"),
    );
    const audioTrack = optional(input.audioTrack, (v) =>
      checkIndex(v, "audioTrack"),
    );
    const subtitle = optional(input.subtitle, (v) => checkText(v, "subtitle"));
    const watched = optional(input.watched, (v) => checkBoolean(v, "watched"));

    // Read, merge and write as one step.
    return this.#transaction(() => {
      if (this.#sql.torrentExists.get(infoHash) === undefined) {
        throw new LibraryError(
          "not_found",
          `Torrent ${infoHash} isn't in the library`,
        );
      }
      const saved = this.getFileProgress(infoHash, fileIndex);
      // null = "not known right now": a file's length doesn't change.
      const knownDuration = duration ?? saved?.duration ?? null;
      const row = this.#sql.upsertProgress.get({
        infoHash,
        fileIndex,
        fileName,
        position,
        duration: knownDuration,
        // undefined = omitted = keep; null = clear.
        audioTrack:
          audioTrack === undefined ? (saved?.audioTrack ?? null) : audioTrack,
        subtitle: subtitle === undefined ? (saved?.subtitle ?? null) : subtitle,
        watched: Number(
          watched ??
            decideWatched({
              position,
              duration: knownDuration,
              wasWatched: saved?.watched ?? false,
            }),
        ),
        updatedAt: this.#timestamp(),
      });
      return toProgressEntry(progressRow.parse(row));
    });
  }

  listContinueWatching(
    limit: number = CONTINUE_WATCHING_LIMIT,
  ): ContinueWatchingEntry[] {
    this.#assertOpen();
    return this.#sql.continueWatching
      .all({
        minPosition: CONTINUE_WATCHING_MIN_POSITION,
        limit: checkLimit(limit),
      })
      .map((row) => {
        const parsed = continueWatchingRow.parse(row);
        return { ...toProgressEntry(parsed), torrentName: parsed.torrent_name };
      });
  }

  deleteProgress(infoHash: string, fileIndex: number): boolean {
    this.#assertOpen();
    checkInfoHash(infoHash);
    checkIndex(fileIndex, "fileIndex");
    const { changes } = this.#sql.deleteProgress.run(infoHash, fileIndex);
    // Also when no row was found: clears a stray thumbnail.
    removeThumbnail(
      thumbnailFile(this.#thumbnailsDir, infoHash, fileIndex),
      this.#logger,
    );
    return Number(changes) > 0;
  }

  forgetTorrent(infoHash: string): boolean {
    this.#assertOpen();
    checkInfoHash(infoHash);
    // Positions go with it (ON DELETE CASCADE).
    const { changes } = this.#sql.deleteTorrent.run(infoHash);
    removeThumbnail(
      thumbnailFolder(this.#thumbnailsDir, infoHash),
      this.#logger,
    );
    return Number(changes) > 0;
  }

  thumbnailPath(infoHash: string, fileIndex: number): string {
    this.#assertOpen();
    return thumbnailFile(
      this.#thumbnailsDir,
      checkInfoHash(infoHash),
      checkIndex(fileIndex, "fileIndex"),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new LibraryError("closed", "The library is closed");
    }
  }

  /** Whole milliseconds: the time columns are INTEGER. */
  #timestamp(): number {
    return Math.trunc(this.#now());
  }

  /** Runs `work` as one transaction: all of it is saved, or none. */
  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
