import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { isGone, TORRENTS_DIR, torrentRecordFile } from "./layout";

// A small file per stored torrent, for fast resume (PLAN §4.4):
//   <cacheDir>/torrents/<infoHash>.streamy.json
//   { "name", "addedAt", "lastUsedAt", "bitfield" (base64) }
//
// It sits next to the torrent's folder, not inside it: WebTorrent writes the
// torrent's own files into <infoHash>/ under names the torrent chooses, so a
// torrent could contain a ".streamy.json" of its own. Next to it, the two
// can never collide, and all records are found with one readdir.
//
// Fast resume with WebTorrent 3.0.21 (checked in node_modules/webtorrent/
// lib/torrent.js, _onMetadata and _verifyPiecesUsingBitfield):
// - Saving: `torrent.bitfield` is a BitField (package "bitfield" 5). Its
//   `.buffer` is a Uint8Array of exactly ceil(pieceCount / 8) bytes, one bit
//   per piece (first piece = highest bit of byte 0). A bit is set once the
//   piece is verified AND written to disk. When a torrent stops, save a copy:
//     bitfield: Uint8Array.from(torrent.bitfield.buffer)
// - Loading: pass the bytes as the `bitfield` option of client.add():
//     client.add(metadata, { path, bitfield: record.bitfield, ... })
//   A Uint8Array/Buffer, not a BitField: WebTorrent compares
//   `bitfield.length` with ceil(pieceCount / 8), and a BitField's length is
//   in bits. A wrong length is silently ignored (a full re-check), so a bad
//   record can only cost time, never data.
// - Do NOT pass `skipVerify: true`. In 3.0.21 it ignores the bitfield and
//   marks every piece as downloaded (it's meant for seeding complete files):
//   a half-downloaded film would be played and shared with holes. With
//   `bitfield` alone, WebTorrent trusts it and hashes one piece per file as a
//   spot check (re-hashing that file if it fails). That is the fast resume.
// - Write the record after the torrent is destroyed (or at least after its
//   last piece is written); a stale, smaller bitfield is safe (those pieces
//   just download again).

export interface TorrentRecord {
  /** The torrent's name, to show a stored torrent without its metadata. */
  name: string;
  /** When it first went into the cache (ms since 1970). */
  addedAt: number;
  /** When it was last used (ms since 1970): eviction deletes the oldest. */
  lastUsedAt: number;
  /** Pieces on disk (WebTorrent's `torrent.bitfield.buffer`). null = unknown. */
  bitfield: Uint8Array | null;
}

/** Where problems reading a record are reported (pino fits as is). */
export interface RecordLogger {
  warn(details: object, message: string): void;
}

const time = z.number().nonnegative();

/** What's in the file. Unknown keys are ignored (a newer Streamy's). */
const recordFile = z.object({
  name: z.string(),
  addedAt: time,
  lastUsedAt: time,
  bitfield: z.base64().nullable(),
});

const recordInput = z.object({
  name: z.string(),
  addedAt: time,
  lastUsedAt: time,
  bitfield: z.instanceof(Uint8Array).nullable(),
});

/**
 * The torrent's record, or null if there's none or it can't be used (broken
 * JSON, wrong shape, unreadable: logged). No record just means a slower start.
 */
export async function readTorrentRecord(
  cacheDir: string,
  infoHash: string,
  logger?: RecordLogger,
): Promise<TorrentRecord | null> {
  const file = torrentRecordFile(cacheDir, infoHash);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!isGone(error)) {
      logger?.warn({ err: error, file }, "Could not read a resume record");
    }
    return null;
  }

  const parsed = recordFile.safeParse(parseJson(text));
  if (!parsed.success) {
    logger?.warn({ file }, "Ignoring a broken resume record");
    return null;
  }
  const { bitfield, ...rest } = parsed.data;
  return {
    ...rest,
    bitfield: bitfield === null ? null : Buffer.from(bitfield, "base64"),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Saves the torrent's record so a crash or power cut never leaves half a
 * file: written to a temporary file, flushed to disk, then renamed over the
 * old one in one step. Never creates the video folder itself (if it's
 * missing, e.g. an unplugged drive, this throws ENOENT).
 */
export async function writeTorrentRecord(
  cacheDir: string,
  infoHash: string,
  record: TorrentRecord,
): Promise<void> {
  const file = torrentRecordFile(cacheDir, infoHash);
  const { bitfield, ...rest } = recordInput.parse(record);
  const json = JSON.stringify(
    {
      ...rest,
      bitfield: bitfield && Buffer.from(bitfield).toString("base64"),
    },
    null,
    2,
  );
  await mkdirIfMissing(join(cacheDir, TORRENTS_DIR));
  await writeFileAtomically(file, `${json}\n`);
}

async function mkdirIfMissing(dir: string): Promise<void> {
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** `.<infoHash>.streamy.json.<pid>-<random>.tmp` */
const TEMP_FILE = /^\.[0-9a-f]{40}\.streamy\.json\.\d+-[0-9a-f]+\.tmp$/;

/** A temporary file left by a save that was cut short. */
export function isRecordTempFile(name: string): boolean {
  return TEMP_FILE.test(name);
}

async function writeFileAtomically(file: string, text: string): Promise<void> {
  const temp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// On Windows, antivirus or indexing can hold the old file for a moment.
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
const ATTEMPTS = 6;

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= ATTEMPTS) throw error;
      await sleep(attempt * 25);
    }
  }
}
