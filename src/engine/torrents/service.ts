import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import parseTorrent, { type ParsedTorrent } from "parse-torrent";
import type { Torrent, Wire, TorrentFile as WebTorrentFile } from "webtorrent";
import type {
  FileKind,
  TorrentDetail,
  TorrentFile,
  TorrentStatus,
  TorrentSummary,
} from "../../shared/engine-api";
import {
  cacheDirState,
  deleteTorrentData,
  readTorrentRecord,
  torrentDataDir,
  torrentRecordFile,
  type TorrentRecord,
  writeTorrentRecord,
} from "../cache";
import { getRuntime } from "../config";
import { AppError, ErrorCode } from "../http/errors";
import { fileKind } from "../lib/file-kind";
import { isInfoHash } from "../lib/info-hash";
import { isLocalUrl } from "../lib/local-address";
import { logger } from "../lib/logger";
import { parseMagnetInput } from "../lib/magnet";
import { ensureVideoFolder } from "../lib/video-folder";
import { getTorrentClient, setDownloadsPaused } from "./client";
import { torrentContentsProblem } from "./contents";
import {
  type InternalFileUrl,
  mintFileToken,
  revokeTorrentTokens,
} from "./file-tokens";
import { describeTorrentError } from "./torrent-errors";

/*
 * The torrent side of the engine, as the rest of it sees it.
 *
 * This file is the seam between torrents and media: the media part
 * (ffprobe, ffmpeg, subtitles, playback) only ever uses what's typed here.
 * The library, the torrent lifecycle and the cache policy hook in through
 * add's options, onMetadata / onRemoved, torrentUsage, stop and
 * deleteStoredTorrent.
 *
 * A torrent here is "active": in the WebTorrent client, connected to peers.
 * Its data lives in <cacheDir>/torrents/<infoHash>/ and stays there when it
 * stops (it's a cache); only remove() deletes it. A record next to it
 * (<infoHash>.streamy.json, cache/record.ts) keeps which pieces are on
 * disk, so the next add trusts them instead of hashing everything again
 * (fast resume). It's saved when the torrent stops, every minute while
 * pieces come in, and when it's complete.
 *
 * One torrent (info hash) at a time: stops, removals, record saves and
 * deletions of the same torrent run one after the other (enqueue), and an
 * add waits for them before it reads what's on disk. Without that, a
 * delete still running could wipe the folder of the torrent just opened
 * again, or a stop could save a record after its data was deleted.
 */

const log = logger.child({ module: "torrents" });

export type AddTorrentInput =
  /** A magnet URI, or a bare 40-char hex info hash. */
  | { magnet: string }
  /** The bytes of a .torrent file. */
  | { torrentFile: Buffer };

/** What the library remembers about a torrent (see AddOptions.saved). */
export type SavedTorrent = {
  /** The .torrent file's bytes; null if its metadata never arrived. */
  metadata: Uint8Array | null;
  /** The magnet it was added with, or null. */
  magnet: string | null;
};

export type AddOptions = {
  /**
   * What the library knows about this info hash, or null. Asked only for a
   * torrent that isn't active. A magnet or info hash then starts from the
   * saved metadata at once, without waiting for peers to send it (the
   * magnet's trackers and peers are still used). A bare info hash also
   * gets the saved magnet's trackers, web seeds and peers.
   */
  saved?: (infoHash: string) => SavedTorrent | null;
  /**
   * Asked right before a torrent that isn't active starts (never for one
   * that is): throws to refuse it, e.g. while the disk is almost full.
   * `known`: its data is in the video folder, or the library knows it.
   */
  admit?: (infoHash: string, known: boolean) => void;
};

export type TorrentFileHandle = {
  infoHash: string;
  index: number;
  name: string;
  /** Path inside the torrent, e.g. "Sintel/Sintel.mp4". */
  path: string;
  size: number;
  kind: FileKind;
  /**
   * A new loopback URL for ffmpeg/ffprobe to read this file with (they seek
   * with Range requests, and every read makes the pieces it needs urgent).
   * Revoke it once the run that needed it is over.
   */
  mintInternalUrl(): InternalFileUrl;
  /** Reads the whole file, waiting for its pieces. For small files only (subtitles). */
  readAll(options: { maxBytes: number }): Promise<Buffer>;
  /** Bytes [start, end] (inclusive), waiting for pieces as needed. */
  createReadStream(range?: { start: number; end: number }): Readable;
};

/** A torrent's metadata arrived: what the library keeps about it. */
export type TorrentMetadataEvent = {
  infoHash: string;
  name: string;
  /**
   * How it was added: the magnet link, or null for a .torrent file (or a
   * bare info hash opened from saved metadata: nothing new to keep).
   */
  magnet: string | null;
  /** The .torrent file (bencoded): re-opens it later without asking peers. */
  torrentFile: Uint8Array;
  /** Bytes of all files. */
  size: number;
  fileCount: number;
};

/** Why onRemoved listeners are called. */
export type TorrentRemoval = {
  /** true = its downloaded data was deleted; false = only stopped. */
  dataDeleted: boolean;
  /** The user asked to forget it too (library: Recent, positions). */
  forget: boolean;
};

export type TorrentService = {
  /**
   * Adds a torrent, or returns the existing one (`created: false`). One
   * that failed is started again.
   */
  add(
    input: AddTorrentInput,
    options?: AddOptions,
  ): Promise<{ torrent: TorrentDetail; created: boolean }>;
  list(): TorrentSummary[];
  /** Throws NOT_FOUND. */
  get(infoHash: string): TorrentDetail;
  /**
   * Stops it and deletes its data, active or not. Fires onRemoved (unless
   * there was nothing to do). Nothing to remove is fine: it's the same
   * outcome.
   */
  remove(infoHash: string, options?: { forget?: boolean }): Promise<void>;
  /**
   * Stops it, keeping its data, and saves its resume record (unless
   * `saveRecord: false`: the data is about to be deleted anyway). Fires
   * onRemoved. Unknown = nothing to do.
   */
  stop(infoHash: string, options?: { saveRecord?: boolean }): Promise<void>;
  /** In the client right now. */
  isActive(infoHash: string): boolean;
  /**
   * Throws NOT_FOUND (no such torrent/file, or it failed) or CONFLICT
   * (metadata not fetched yet, or the data on disk is being checked).
   */
  getFile(infoHash: string, fileIndex: number): TorrentFileHandle;
  /**
   * "This is the file being watched": the other files stop downloading,
   * and (backgroundDownload) the rest of this one keeps downloading at low
   * priority. Called when a playback starts.
   */
  focusFile(infoHash: string, fileIndex: number): void;
  /** Marks the torrent as in use. */
  touch(infoHash: string): void;
  /** Called when a torrent's metadata is known. Returns an unsubscribe. */
  onMetadata(listener: (event: TorrentMetadataEvent) => void): () => void;
  /** Called after a torrent is stopped or removed. Returns an unsubscribe. */
  onRemoved(
    listener: (infoHash: string, removal: TorrentRemoval) => void,
  ): () => void;
};

type Entry = {
  infoHash: string;
  torrent: Torrent;
  /**
   * The video folder it was added in. Kept when the setting changes: it
   * runs there until it stops, and its record is saved there.
   */
  cacheDir: string;
  /** Its data folder: <cacheDir>/torrents/<infoHash>. */
  dir: string;
  /** The magnet it was added with (see TorrentMetadataEvent.magnet). */
  magnet: string | null;
  /** The .torrent bytes it started from (a file, or saved metadata). */
  sourceFile: Buffer | null;
  /** When it became active in this run. */
  addedAt: number;
  /** When its data first went into the video folder (kept in its record). */
  storedSince: number;
  lastActivityAt: number;
  /**
   * Why it failed, for people. WebTorrent destroys a torrent on error, but
   * the entry stays (status "error") so the user sees why, until it's
   * removed or opened again.
   */
  error: string | null;
  /** Known once the metadata arrives; kept after an error. */
  name: string | null;
  size: number | null;
  /** The file downloading in the background (focusFile). */
  focusedFile: number | null;
  /** Reads in progress. Cut when the torrent goes away. */
  streams: Set<Readable>;
  /**
   * Peers we connected to (and the magnet's x.pe), newest last, to connect
   * to again after downloads were paused (see pauseDownloads).
   */
  peerAddresses: Set<string>;
  /** Pieces were verified since the record was last saved. */
  recordDirty: boolean;
  /** The next periodic record save. */
  recordTimer: NodeJS.Timeout | null;
};

const registry = new Map<string, Entry>();
/** add() calls between "not active" and the torrent being registered. */
const adding = new Map<string, Promise<unknown>>();
/** The last stop / removal / record save / deletion of each torrent. */
const queue = new Map<string, Promise<void>>();
const metadataListeners = new Set<(event: TorrentMetadataEvent) => void>();
const removedListeners = new Set<
  (infoHash: string, removal: TorrentRemoval) => void
>();
/** The disk is almost full: nothing is downloaded (pauseDownloads). */
let backgroundPaused = false;

/** How often an active torrent's record is saved while pieces come in. */
export const RECORD_SAVE_MS = 60_000;
/** WebTorrent's own wait for a peer's answer (PIECE_TIMEOUT in torrent.js). */
const PEER_REQUEST_TIMEOUT_MS = 30_000;
/** Peers remembered per torrent for reconnecting after a pause. */
const MAX_REMEMBERED_PEERS = 100;

function noop(): void {
  // Nothing: errors are handled where the work is awaited.
}

// ─── One torrent at a time ───────────────────────────────────────────────────

/**
 * Runs `work` once everything queued before it for this torrent is done.
 * Registered at once (synchronously), so add() and deleteStoredTorrent()
 * see it straight away. The returned promise fails if `work` does; the
 * queue itself carries on.
 */
function enqueue(infoHash: string, work: () => Promise<void>): Promise<void> {
  const run = (queue.get(infoHash) ?? Promise.resolve()).then(work);
  const settled = run.then(noop, noop);
  queue.set(infoHash, settled);
  void settled.then(() => {
    if (queue.get(infoHash) === settled) queue.delete(infoHash);
  });
  return run;
}

/**
 * Waits until no stop, removal or deletion of any torrent is going on.
 * "Clear now" waits for this before deleting, so a stop that was already
 * going can't write its record after the folder was emptied.
 */
export async function settleAllTorrents(): Promise<void> {
  while (queue.size > 0) await Promise.all(queue.values());
}

// ─── Adding ──────────────────────────────────────────────────────────────────

/** What add() starts a torrent from. */
type Identified = {
  /** What WebTorrent gets: a magnet, or a parsed torrent. */
  torrentId: string | ParsedTorrent;
  parsed: ParsedTorrent;
  magnet: string | null;
  /** The .torrent bytes it starts from, if any (for onMetadata). */
  sourceFile: Buffer | null;
};

/** The file list of a parsed .torrent, refused if it's hostile. */
function contentsProblemOf(parsed: ParsedTorrent): string | null {
  return torrentContentsProblem({
    files: (parsed.files ?? []).map((file) => file.path),
    info: parsed.info,
  });
}

/**
 * A .torrent's trackers and web seeds, without those on this computer or
 * the local network (same rule as magnets: lib/magnet.ts).
 */
function withoutLocalSources(parsed: ParsedTorrent): ParsedTorrent {
  if (getRuntime().tuning.allowLocalAddresses) return parsed;
  const isPublic = (url: string) => !isLocalUrl(url);
  return {
    ...parsed,
    announce: parsed.announce?.filter(isPublic),
    urlList: parsed.urlList?.filter(isPublic),
  };
}

async function identifyMagnet(text: string): Promise<Identified> {
  const result = parseMagnetInput(text, {
    allowLocalAddresses: getRuntime().tuning.allowLocalAddresses,
  });
  if ("error" in result) {
    throw new AppError(ErrorCode.BadRequest, result.error);
  }
  const parsed = await parseTorrent(result.magnet).catch(() => null);
  if (!parsed || !isInfoHash(parsed.infoHash)) {
    throw new AppError(
      ErrorCode.BadRequest,
      "This magnet link has no BitTorrent info hash",
    );
  }
  return {
    torrentId: result.magnet,
    parsed,
    magnet: result.magnet,
    sourceFile: null,
  };
}

/** Works out the info hash before adding, so duplicates are caught. */
async function identify(input: AddTorrentInput): Promise<Identified> {
  if ("magnet" in input) return identifyMagnet(input.magnet);

  // `info` is what makes it a real .torrent file: parse-torrent would read
  // any 20 bytes as a bare info hash.
  const parsed = await parseTorrent(input.torrentFile).catch(() => null);
  if (!parsed?.info) {
    throw new AppError(
      ErrorCode.BadRequest,
      "This isn't a valid .torrent file",
    );
  }
  // The file list is right here: refuse a hostile one before adding it.
  const problem = contentsProblemOf(parsed);
  if (problem) throw new AppError(ErrorCode.BadRequest, problem);
  return {
    torrentId: withoutLocalSources(parsed),
    parsed,
    magnet: null,
    sourceFile: input.torrentFile,
  };
}

/** Both lists, each address once (order kept). */
function union(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/** What the library saved about it, or null (a failing library is logged). */
function lookUpSaved(
  options: AddOptions,
  infoHash: string,
): SavedTorrent | null {
  try {
    return options.saved?.(infoHash) ?? null;
  } catch (err) {
    log.warn({ err, infoHash }, "Couldn't read what the library saved");
    return null;
  }
}

/**
 * A bare info hash says nothing about where peers are: use the magnet the
 * library saved for it instead (checked again, as it may come from an
 * older Streamy with other rules). The library already has that magnet,
 * so it isn't reported again (`magnet: null`).
 */
async function withSavedMagnet(
  bare: Identified,
  savedMagnet: string,
): Promise<Identified> {
  const saved = await identifyMagnet(savedMagnet).catch(() => null);
  if (saved?.parsed.infoHash !== bare.parsed.infoHash) return bare;
  return { ...saved, magnet: null };
}

/**
 * A magnet the library has metadata for: start from that metadata, with
 * the magnet's trackers, web seeds and peers (x.pe) added. null = use the
 * magnet as it is (the saved bytes can't be used).
 */
async function fromSavedMetadata(
  magnet: Identified,
  bytes: Uint8Array,
  bareHash: boolean,
): Promise<Identified | null> {
  const { infoHash } = magnet.parsed;
  const saved = await parseTorrent(bytes).catch(() => null);
  const problem = saved?.info ? contentsProblemOf(saved) : "not a .torrent";
  if (!saved || saved.infoHash !== infoHash || problem) {
    log.warn({ infoHash, problem }, "Ignoring unusable saved metadata");
    return null;
  }
  const sources = withoutLocalSources(saved);
  return {
    torrentId: {
      ...saved,
      announce: union(sources.announce, magnet.parsed.announce),
      urlList: union(sources.urlList, magnet.parsed.urlList),
      peerAddresses: magnet.parsed.peerAddresses ?? [],
    },
    parsed: saved,
    // A bare hash says nothing the metadata doesn't: keep the saved magnet.
    magnet: bareHash ? null : magnet.magnet,
    sourceFile: Buffer.from(bytes),
  };
}

async function isFolder(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
}

/**
 * What's on disk for it: its record, for fast resume (only with its data
 * folder: a record without its data claims pieces that aren't there), and
 * whether there's any data at all.
 */
async function storedState(
  cacheDir: string,
  infoHash: string,
  dir: string,
): Promise<{ record: TorrentRecord | null; hasData: boolean }> {
  const [record, hasData] = await Promise.all([
    readTorrentRecord(cacheDir, infoHash, log),
    isFolder(dir),
  ]);
  return { record: hasData ? record : null, hasData };
}

/** The part of add() for a torrent that isn't active. */
async function start(
  input: AddTorrentInput,
  identified: Identified,
  options: AddOptions,
): Promise<{ torrent: TorrentDetail; created: boolean }> {
  const { infoHash } = identified.parsed;
  const saved = lookUpSaved(options, infoHash);

  let source = identified;
  let fromSaved = false;
  if ("magnet" in input) {
    const bareHash = isInfoHash(input.magnet.trim().toLowerCase());
    if (bareHash && saved?.magnet) {
      source = await withSavedMagnet(source, saved.magnet);
    }
    if (saved?.metadata) {
      const metadata = await fromSavedMetadata(
        source,
        saved.metadata,
        bareHash,
      );
      fromSaved = metadata !== null;
      source = metadata ?? source;
    }
  }

  // 503 when the video folder is gone (an unplugged drive).
  const { config, tuning } = getRuntime();
  const { cacheDir } = config;
  const paths = await ensureVideoFolder(cacheDir);
  const dir = join(paths.torrents, infoHash);
  const { record, hasData } = await storedState(cacheDir, infoHash, dir);

  // From here on everything is synchronous. Asked last, so a "Clear now"
  // or a full disk that started while this waited still counts.
  options.admit?.(infoHash, hasData || saved !== null);

  const torrent = getTorrentClient().add(source.torrentId, {
    path: dir,
    deselect: true,
    // Private torrents must only talk to their own trackers.
    announce: source.parsed.private ? [] : tuning.trackers,
    // Fast resume. Never `skipVerify` (see cache/record.ts).
    ...(record?.bitfield && { bitfield: record.bitfield }),
  });

  const now = Date.now();
  const entry: Entry = {
    infoHash,
    torrent,
    cacheDir,
    dir,
    magnet: source.magnet,
    sourceFile: source.sourceFile,
    addedAt: now,
    storedSince: record?.addedAt ?? now,
    lastActivityAt: now,
    error: null,
    name: null,
    size: null,
    focusedFile: null,
    streams: new Set(),
    peerAddresses: new Set(),
    recordDirty: false,
    recordTimer: null,
  };
  for (const peer of source.parsed.peerAddresses ?? []) {
    rememberPeer(entry, peer);
  }
  registry.set(infoHash, entry);
  watch(entry);
  log.info(
    {
      infoHash,
      fromSavedMetadata: fromSaved,
      fastResume: Boolean(record?.bitfield),
    },
    "Torrent added",
  );

  return { torrent: toDetail(entry), created: true };
}

/** A magnet for a torrent that's already active: connect to its x.pe peers. */
function addPeersOf(entry: Entry, identified: Identified): void {
  for (const peer of identified.parsed.peerAddresses ?? []) {
    rememberPeer(entry, peer);
    connectTo(entry, peer);
  }
}

async function add(
  input: AddTorrentInput,
  options: AddOptions = {},
): Promise<{ torrent: TorrentDetail; created: boolean }> {
  const identified = await identify(input);
  const { infoHash } = identified.parsed;

  for (;;) {
    const existing = registry.get(infoHash);
    if (existing?.error === null) {
      touchEntry(existing);
      addPeersOf(existing, identified);
      return { torrent: toDetail(existing), created: false };
    }
    // It failed: opening it again is a retry.
    if (existing) dropFailed(existing);
    // Being added already (a double click), or a stop or delete of it is
    // still going: wait for that, then look again.
    const busy = adding.get(infoHash) ?? queue.get(infoHash);
    if (!busy) break;
    await busy.catch(noop);
  }

  // Synchronously after the checks above: from now on a delete of this
  // torrent waits for this add (deleteStoredTorrent, remove).
  const starting = start(input, identified, options);
  adding.set(infoHash, starting);
  try {
    return await starting;
  } finally {
    if (adding.get(infoHash) === starting) adding.delete(infoHash);
  }
}

function watch(entry: Entry) {
  const { torrent, infoHash } = entry;

  // Every read waiting for a piece listens for "verified". Many parallel
  // reads (browser + ffmpeg + subtitles) are normal, not a leak.
  torrent.setMaxListeners(0);

  torrent.on("metadata", () => {
    const problem = torrentContentsProblem({
      files: torrent.files.map((file) => file.path),
      info: torrent.info,
    });
    if (problem) {
      fail(entry, problem);
      discardHostile(entry);
      return;
    }
    entry.name = torrent.name;
    entry.size = torrent.length;
    // No name or file names: the log mustn't say what someone watches.
    log.info(
      { infoHash, files: torrent.files.length },
      "Torrent metadata received",
    );
    emitMetadata(entry);
  });

  torrent.on("error", (err: unknown) => {
    fail(entry, describeTorrentError(err), err);
  });

  // Dead trackers, web seeds that fail, …: normal on the open internet.
  torrent.on("warning", (err: unknown) => {
    log.debug({ infoHash, err }, "Torrent warning");
  });

  // A piece is on disk (also while checking what's there after a start).
  torrent.on("verified", () => {
    entry.recordDirty = true;
    scheduleRecordSave(entry);
  });

  torrent.on("done", () => {
    log.info({ infoHash }, "Torrent fully downloaded");
    saveRecordNow(entry);
  });

  torrent.on("wire", (wire: Wire, address: string | undefined) => {
    // Downloads are paused: the peer's answers are held back on purpose.
    if (backgroundPaused) holdWire(wire, true);
    // Only peers we connected to have an address worth trying again.
    if (address && wire.type.endsWith("Outgoing")) {
      rememberPeer(entry, address);
    }
  });

  torrent.on("close", () => {
    closeStreams(entry);
    // Destroyed without an error and without us stopping it.
    if (registry.get(infoHash) === entry && entry.error === null) {
      fail(entry, "The download stopped unexpectedly");
    }
  });
}

/**
 * Marks it failed: `message` is what people read, `err` (if any) what
 * went wrong underneath, for the log only.
 */
function fail(entry: Entry, message: string, err?: unknown) {
  entry.error = message;
  clearRecordTimer(entry);
  log.warn({ infoHash: entry.infoHash, error: message, err }, "Torrent failed");
}

/**
 * A torrent whose file list turned out hostile: stopped right away (before
 * WebTorrent starts checking those files), its folder deleted.
 */
function discardHostile(entry: Entry) {
  const closing = closeTorrent(entry, { destroyStore: true });
  void enqueue(entry.infoHash, async () => {
    await closing;
    await deleteStoredData(entry.cacheDir, entry.infoHash);
  });
}

function emitMetadata(entry: Entry) {
  const { torrent } = entry;
  const torrentFile = entry.sourceFile ?? torrent.torrentFile;
  if (!torrentFile || metadataListeners.size === 0) return;

  const event: TorrentMetadataEvent = {
    infoHash: entry.infoHash,
    name: torrent.name,
    magnet: entry.magnet,
    torrentFile,
    size: torrent.length,
    fileCount: torrent.files.length,
  };
  for (const listener of metadataListeners) {
    try {
      listener(event);
    } catch (err) {
      log.error({ err }, "A torrent onMetadata listener failed");
    }
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

function findEntry(infoHash: string): Entry {
  const entry = registry.get(infoHash);
  if (!entry) throw new AppError(ErrorCode.NotFound, "Torrent not found");
  return entry;
}

function findFile(
  infoHash: string,
  fileIndex: number,
): { entry: Entry; file: WebTorrentFile } {
  const entry = findEntry(infoHash);
  // Not 409: the UI retries 409s until the metadata is in, and a failed
  // torrent will never get there.
  if (entry.error !== null) {
    throw new AppError(
      ErrorCode.NotFound,
      `This torrent failed: ${entry.error}`,
    );
  }
  if (!entry.torrent.ready) {
    throw new AppError(
      ErrorCode.Conflict,
      entry.name === null
        ? "The torrent's file list isn't known yet. Try again in a moment."
        : "Streamy is checking what's already downloaded. Try again in a moment.",
    );
  }
  const file = entry.torrent.files[fileIndex];
  if (!file) throw new AppError(ErrorCode.NotFound, "File not found");
  return { entry, file };
}

function getFile(infoHash: string, fileIndex: number): TorrentFileHandle {
  const { entry, file } = findFile(infoHash, fileIndex);
  return {
    infoHash,
    index: fileIndex,
    name: file.name,
    path: toPosixPath(file.path),
    size: file.length,
    kind: fileKind(file.name),
    mintInternalUrl: () => mintFileToken({ infoHash, fileIndex }),
    readAll: ({ maxBytes }) => readAll(entry, file, maxBytes),
    createReadStream: (range) => openStream(entry, file, range),
  };
}

async function readAll(
  entry: Entry,
  file: WebTorrentFile,
  maxBytes: number,
): Promise<Buffer> {
  if (file.length > maxBytes) {
    throw new AppError(
      ErrorCode.BadRequest,
      `This file is too big to read (${megabytes(file.length)}, the limit is ${megabytes(maxBytes)})`,
    );
  }
  return buffer(openStream(entry, file));
}

function openStream(
  entry: Entry,
  file: WebTorrentFile,
  range: { start: number; end: number } = { start: 0, end: file.length - 1 },
): Readable {
  if (entry.torrent.destroyed) {
    throw new AppError(ErrorCode.NotFound, "This torrent was removed");
  }
  const { start, end } = range;
  if (file.length === 0) return Readable.from([]);
  if (start < 0 || end < start || end >= file.length) {
    throw new AppError(ErrorCode.BadRequest, "Invalid byte range");
  }

  const stream = readFileRange(file, start, end);
  entry.streams.add(stream);
  stream.once("close", () => {
    entry.streams.delete(stream);
    // Reading is using it: the idle timer starts when the last read ends.
    touchEntry(entry);
  });
  return stream;
}

/**
 * A Node stream of bytes [start, end] of a torrent file. Creating it makes
 * those pieces urgent; destroying it (the viewer seeked, ffmpeg moved on)
 * drops that priority, so the old position stops downloading.
 *
 * Not WebTorrent's own createReadStream: that's a streamx stream which, when
 * destroyed with an error (what pipeline does on a closed connection),
 * never releases its pieces.
 */
function readFileRange(
  file: WebTorrentFile,
  start: number,
  end: number,
): Readable {
  // WebTorrent reads `end: 0` as "to the end of the file": a 1-byte read
  // of byte 0 (a browser probing) would make the whole file urgent. Byte 1
  // is in the same piece; only `left` bytes are passed on anyway.
  const pieces = file[Symbol.asyncIterator]({
    start,
    end: end === 0 ? Math.min(1, file.length - 1) : end,
  });
  let left = end - start + 1;

  return new Readable({
    read() {
      pieces.next().then(
        ({ value, done }) => {
          if (this.destroyed) return;
          if (done) {
            // WebTorrent ends quietly when the torrent goes away: never pass
            // a cut-off file off as complete.
            if (left > 0)
              this.destroy(new Error("The file stream ended early"));
            else this.push(null);
            return;
          }
          const chunk = value.length > left ? value.subarray(0, left) : value;
          left -= chunk.length;
          this.push(chunk);
          if (left === 0) this.push(null);
        },
        (err: unknown) => {
          this.destroy(err instanceof Error ? err : new Error(String(err)));
        },
      );
    },
    destroy(err, callback) {
      pieces.return().catch(() => undefined);
      callback(err);
    },
  });
}

/** Ends every read of this torrent (it's going away). */
function closeStreams(entry: Entry) {
  for (const stream of entry.streams) stream.destroy();
  entry.streams.clear();
}

// ─── Status ──────────────────────────────────────────────────────────────────

function statusOf(entry: Entry): TorrentStatus {
  if (entry.error !== null) return "error";
  // The file list is known from the metadata on; "ready" comes once
  // WebTorrent has checked what's already on disk.
  if (entry.name === null) return "fetching_metadata";
  return entry.torrent.ready ? "ready" : "checking";
}

function toSummary(entry: Entry): TorrentSummary {
  const { torrent } = entry;
  const live = !torrent.destroyed;
  return {
    infoHash: entry.infoHash,
    name: entry.name,
    status: statusOf(entry),
    error: entry.error,
    size: entry.size,
    progress: clamp01(torrent.progress),
    downloadSpeed: live ? Math.round(torrent.downloadSpeed) : 0,
    uploadSpeed: live ? Math.round(torrent.uploadSpeed) : 0,
    peers: live ? torrent.numPeers : 0,
    addedAt: new Date(entry.addedAt).toISOString(),
    lastActivityAt: new Date(entry.lastActivityAt).toISOString(),
  };
}

function toDetail(entry: Entry): TorrentDetail {
  const { torrent } = entry;
  const hasFiles = entry.name !== null && !torrent.destroyed;
  return {
    ...toSummary(entry),
    files: hasFiles
      ? torrent.files.map((file, index): TorrentFile => ({
          index,
          name: file.name,
          path: toPosixPath(file.path),
          size: file.length,
          kind: fileKind(file.name),
          // WebTorrent 3.0.21 leaves out the last piece of a file that ends
          // exactly on a piece boundary: such a file never reaches 1.
          progress: file.done ? 1 : clamp01(file.progress),
        }))
      : [],
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Resume records ──────────────────────────────────────────────────────────

/**
 * What the torrent's record should say right now, or null when there's
 * nothing worth keeping (no metadata yet, or it failed). A bit is only set
 * once its piece is written, so the copy never claims a piece that isn't
 * on disk.
 */
function recordOf(entry: Entry): TorrentRecord | null {
  const { torrent } = entry;
  if (entry.error !== null || entry.name === null || !torrent.bitfield) {
    return null;
  }
  return {
    name: entry.name,
    addedAt: entry.storedSince,
    lastUsedAt: entry.lastActivityAt,
    bitfield: Uint8Array.from(torrent.bitfield.buffer),
  };
}

/** Saves the record next to its data (the folder it was added in). */
async function saveRecord(entry: Entry, record: TorrentRecord): Promise<void> {
  try {
    await writeTorrentRecord(entry.cacheDir, entry.infoHash, record);
  } catch (err) {
    // Only costs time: the next start checks the data instead.
    log.warn(
      { err, infoHash: entry.infoHash },
      "Couldn't save the resume record",
    );
  }
}

function clearRecordTimer(entry: Entry) {
  if (entry.recordTimer) clearTimeout(entry.recordTimer);
  entry.recordTimer = null;
}

/**
 * Saves the record within a minute (RECORD_SAVE_MS): a crash or power cut
 * then only costs the pieces since, not a full check of everything.
 */
function scheduleRecordSave(entry: Entry) {
  if (entry.recordTimer) return;
  entry.recordTimer = setTimeout(() => {
    entry.recordTimer = null;
    saveRecordNow(entry);
  }, RECORD_SAVE_MS);
  entry.recordTimer.unref();
}

/**
 * Saves an active torrent's record now if pieces came in since the last
 * save (in its turn: never after a stop or delete of it that came first).
 * Not while it's still checking what's on disk: that isn't known yet.
 */
function saveRecordNow(entry: Entry) {
  clearRecordTimer(entry);
  const active = registry.get(entry.infoHash) === entry;
  if (!active || !entry.recordDirty || !entry.torrent.ready) return;
  const record = recordOf(entry);
  if (!record) return;
  entry.recordDirty = false;
  void enqueue(entry.infoHash, () => saveRecord(entry, record));
}

// ─── Stopping and removing ───────────────────────────────────────────────────

function notifyRemoved(infoHash: string, removal: TorrentRemoval) {
  revokeTorrentTokens(infoHash);
  for (const listener of removedListeners) {
    try {
      listener(infoHash, removal);
    } catch (err) {
      log.error({ err }, "A torrent onRemoved listener failed");
    }
  }
}

/**
 * Destroys the torrent, closing its files (`destroyStore`: deleting them
 * too). Starts right away; resolves once done (at most 5 s: trackers get
 * a goodbye, slow ones aren't waited for).
 */
function closeTorrent(
  { torrent, infoHash }: Entry,
  { destroyStore }: { destroyStore: boolean },
): Promise<void> {
  if (torrent.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    torrent.destroy({ destroyStore }, (err) => {
      if (err) log.warn({ err, infoHash }, "Torrent didn't stop cleanly");
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Stops an active torrent: out of the registry first (so its "close"
 * isn't a failure), then closed, then its record saved or (removal) its
 * data deleted, in its turn.
 */
function stopEntry(
  entry: Entry,
  removal: TorrentRemoval,
  { saveRecord: save = !removal.dataDeleted }: { saveRecord?: boolean } = {},
): Promise<void> {
  const { infoHash } = entry;
  if (registry.get(infoHash) !== entry) return Promise.resolve();
  registry.delete(infoHash);
  clearRecordTimer(entry);
  const record = save ? recordOf(entry) : null;
  closeStreams(entry);
  log.info(
    { infoHash, dataDeleted: removal.dataDeleted },
    removal.dataDeleted ? "Torrent removed" : "Torrent stopped",
  );
  notifyRemoved(infoHash, removal);
  const closing = closeTorrent(entry, { destroyStore: removal.dataDeleted });
  return enqueue(infoHash, async () => {
    // After the close: its files are closed, every counted piece is written.
    await closing;
    // The store deletes files but not folders (and nothing at all when
    // WebTorrent destroyed the torrent itself after an error).
    if (removal.dataDeleted) await deleteStoredData(entry.cacheDir, infoHash);
    else if (record) await saveRecord(entry, record);
  });
}

/**
 * A failed torrent opened again: forgotten here (its data and the library
 * stay), so add() can start it fresh.
 */
function dropFailed(entry: Entry) {
  const { infoHash } = entry;
  registry.delete(infoHash);
  clearRecordTimer(entry);
  closeStreams(entry);
  log.info({ infoHash }, "Opening a failed torrent again");
  notifyRemoved(infoHash, { dataDeleted: false, forget: false });
  // WebTorrent destroys a torrent that fails; this is in case it didn't.
  const closing = closeTorrent(entry, { destroyStore: false });
  void enqueue(infoHash, () => closing);
}

/** Deletes a torrent's folder and record (only in a folder that's Streamy's). */
async function deleteStoredData(cacheDir: string, infoHash: string) {
  try {
    await deleteTorrentData(cacheDir, infoHash);
  } catch (err) {
    log.warn({ err, infoHash }, "Couldn't delete the torrent's data");
  }
}

/** A stopped torrent's data or record is still in the video folder. */
async function hasStoredData(
  cacheDir: string,
  infoHash: string,
): Promise<boolean> {
  const state = await cacheDirState(cacheDir).catch(() => "unreadable");
  if (state !== "ok") return false;
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );
  return (
    (await exists(torrentDataDir(cacheDir, infoHash))) ||
    (await exists(torrentRecordFile(cacheDir, infoHash)))
  );
}

async function remove(
  infoHash: string,
  { forget = false }: { forget?: boolean } = {},
): Promise<void> {
  // It becomes a path below: only ever a real info hash. Nothing can be
  // stored under anything else.
  if (!isInfoHash(infoHash)) return;

  // Being opened right now: let that finish, then remove what it opened.
  for (let busy = adding.get(infoHash); busy; busy = adding.get(infoHash)) {
    await busy.catch(noop);
  }
  const entry = registry.get(infoHash);
  if (entry) return stopEntry(entry, { dataDeleted: true, forget });

  // Not active: it may still have data on disk from an earlier run. Only
  // ever deleted from a folder marked as Streamy's.
  const { cacheDir } = getRuntime().config;
  return enqueue(infoHash, async () => {
    const onDisk = await hasStoredData(cacheDir, infoHash);
    // Nothing there and nothing to forget: already the way it should be.
    if (!onDisk && !forget) return;
    if (onDisk) await deleteStoredData(cacheDir, infoHash);
    log.info({ infoHash, forget }, "Stored torrent removed");
    notifyRemoved(infoHash, { dataDeleted: onDisk, forget });
  });
}

/**
 * The cache policy deletes a stored torrent's data and record. Decided at
 * once, before anything is awaited: false (nothing deleted) when it's
 * active or being opened. An open that starts afterwards waits for the
 * deletion and starts fresh. Throws when the deletion fails.
 */
export function deleteStoredTorrent(
  cacheDir: string,
  infoHash: string,
): Promise<boolean> {
  if (registry.has(infoHash) || adding.has(infoHash)) {
    return Promise.resolve(false);
  }
  return enqueue(infoHash, () => deleteTorrentData(cacheDir, infoHash)).then(
    () => true,
  );
}

// ─── Activity ────────────────────────────────────────────────────────────────

function touchEntry(entry: Entry) {
  entry.lastActivityAt = Date.now();
}

/** How long nobody used it. A torrent being read right now isn't idle. */
function idleFor(entry: Entry, now: number): number {
  return entry.streams.size > 0 ? 0 : now - entry.lastActivityAt;
}

/** What the lifecycle and cache policy need to know about each active torrent. */
export type TorrentUsage = {
  infoHash: string;
  /** Milliseconds since anyone used it (0 while a read is in progress). */
  idleMs: number;
  lastActivityAt: number;
  /** Bytes downloaded so far. */
  downloaded: number;
  /** It failed (status "error"): only kept so the user sees why. */
  failed: boolean;
};

export function torrentUsage(now = Date.now()): TorrentUsage[] {
  return [...registry.values()].map((entry) => ({
    infoHash: entry.infoHash,
    idleMs: idleFor(entry, now),
    lastActivityAt: entry.lastActivityAt,
    downloaded: entry.torrent.destroyed ? 0 : entry.torrent.downloaded,
    failed: entry.error !== null,
  }));
}

/** Stops the background download of the watched file (disk is full). */
export function stopBackgroundDownload(infoHash: string): void {
  const entry = registry.get(infoHash);
  if (!entry || entry.focusedFile === null || entry.torrent.destroyed) return;
  entry.torrent.files[entry.focusedFile]?.deselect();
  entry.focusedFile = null;
}

/** Some active torrent still has pieces (or its metadata) to get. */
export function hasUnfinishedTorrents(): boolean {
  for (const entry of registry.values()) {
    const { torrent } = entry;
    if (entry.error === null && !torrent.destroyed && !torrent.done) {
      return true;
    }
  }
  return false;
}

// ─── Pausing (disk almost full) ──────────────────────────────────────────────

/** Remembers a peer to connect to again; the oldest go past the cap. */
function rememberPeer(entry: Entry, address: string) {
  entry.peerAddresses.delete(address);
  entry.peerAddresses.add(address);
  if (entry.peerAddresses.size > MAX_REMEMBERED_PEERS) {
    const [oldest] = entry.peerAddresses;
    if (oldest !== undefined) entry.peerAddresses.delete(oldest);
  }
}

function connectTo(entry: Entry, address: string) {
  try {
    entry.torrent.addPeer(address);
  } catch (err) {
    // Destroyed meanwhile, or its info hash isn't known yet.
    log.debug({ err, infoHash: entry.infoHash }, "Couldn't add a peer");
  }
}

/**
 * While downloads are paused, a peer's answers wait in WebTorrent's
 * throttle, so WebTorrent would think it stopped answering and drop it
 * after 30 s. No timeout while paused; WebTorrent's own after. (Web seeds
 * have no such timeout.)
 */
function holdWire(wire: Wire, paused: boolean) {
  if (wire.type === "webSeed") return;
  wire.setTimeout(paused ? 0 : PEER_REQUEST_TIMEOUT_MS, true);
}

/**
 * After a pause: connects again to the peers it had. A connection that
 * started during the pause couldn't finish its handshake (held back too),
 * and WebTorrent gives up on an address after 3 tries. Then asks the
 * trackers for peers again.
 */
function reconnect(entry: Entry) {
  for (const address of entry.peerAddresses) connectTo(entry, address);
  try {
    entry.torrent.discovery?.tracker?.update();
  } catch (err) {
    log.debug({ err, infoHash: entry.infoHash }, "Couldn't ask the trackers");
  }
}

/**
 * The disk is almost full: nothing more is downloaded until resumed. Peers'
 * data (web seeds' too) is held back (client.ts), and the watched files'
 * background downloads are dropped. Connections are kept: they don't time
 * out while held (holdWire), and on resume the torrent connects again to
 * the peers it had. Reading what's on disk keeps working throughout.
 */
export function pauseDownloads(paused: boolean): void {
  if (backgroundPaused === paused) return;
  backgroundPaused = paused;
  setDownloadsPaused(paused);
  const { backgroundDownload } = getRuntime().tuning;
  for (const entry of registry.values()) {
    const { torrent } = entry;
    if (torrent.destroyed) continue;
    for (const wire of torrent.wires) holdWire(wire, paused);
    if (entry.focusedFile !== null) {
      const file = torrent.files[entry.focusedFile];
      if (paused) file?.deselect();
      else if (backgroundDownload) file?.select();
    }
    if (!paused) reconnect(entry);
  }
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

/**
 * Shutdown, before the client goes: saves every active torrent's record,
 * so the next launch resumes them without hashing everything.
 */
export async function saveTorrentRecords(): Promise<void> {
  await Promise.all(
    [...registry.values()].map((entry) => {
      clearRecordTimer(entry);
      const record = recordOf(entry);
      if (!record) return Promise.resolve();
      return enqueue(entry.infoHash, () => saveRecord(entry, record));
    }),
  );
}

/**
 * Shutdown: forgets every torrent without failing them (the client is
 * destroyed next, keeping the data). onRemoved isn't called: the engine is
 * going away as a whole.
 */
export function releaseAllTorrents(): void {
  for (const entry of registry.values()) {
    clearRecordTimer(entry);
    closeStreams(entry);
  }
  registry.clear();
  backgroundPaused = false;
}

// ─── The service ─────────────────────────────────────────────────────────────

export const torrentService: TorrentService = {
  add,

  list() {
    return [...registry.values()]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map(toSummary);
  },

  get(infoHash) {
    return toDetail(findEntry(infoHash));
  },

  remove,

  async stop(infoHash, { saveRecord: save = true } = {}) {
    const entry = registry.get(infoHash);
    if (!entry) return;
    await stopEntry(
      entry,
      { dataDeleted: false, forget: false },
      { saveRecord: save },
    );
  },

  isActive(infoHash) {
    return registry.has(infoHash);
  },

  getFile,

  focusFile(infoHash, fileIndex) {
    const { entry, file } = findFile(infoHash, fileIndex);
    if (entry.focusedFile === fileIndex) return;

    // deselect() only drops background selections: reads in progress on
    // other files (a subtitle) still finish.
    entry.torrent.files.forEach((other, index) => {
      if (index !== fileIndex) other.deselect();
    });
    // Priority 0: below every read, so seeking always comes first. Not
    // while downloads are paused (pauseDownloads selects it on resume).
    if (getRuntime().tuning.backgroundDownload && !backgroundPaused) {
      file.select();
    }
    entry.focusedFile = fileIndex;
  },

  touch(infoHash) {
    const entry = registry.get(infoHash);
    if (entry) touchEntry(entry);
  },

  onMetadata(listener) {
    metadataListeners.add(listener);
    return () => {
      metadataListeners.delete(listener);
    };
  },

  onRemoved(listener) {
    removedListeners.add(listener);
    return () => {
      removedListeners.delete(listener);
    };
  },
};
