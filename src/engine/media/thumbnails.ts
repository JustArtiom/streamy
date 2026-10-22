import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { constants, setPriority } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CONTINUE_WATCHING_MIN_POSITION,
  type LibraryStore,
  type ProgressEntry,
} from "../library";
import { logger } from "../lib/logger";
import type { InternalFileUrl } from "../torrents/file-tokens";
import { torrentInputArgs } from "./ffmpeg-args";
import { lastLines, runProcess } from "./run";

/*
 * Continue-watching thumbnails (Phase 4): one frame near the saved position,
 * grabbed by ffmpeg in the background and kept at library.thumbnailPath().
 *
 * - Made once a file's position is saved past 30 s (when it shows up in
 *   Continue watching), and made again once the position is more than
 *   5 minutes away from the frame's: the picture follows the viewer.
 * - Which position a thumbnail shows is written into the JPEG itself (a
 *   comment segment), so that survives restarts without a database column.
 * - One ffmpeg at a time, at the lowest priority, for at most 20 s. Never
 *   while the disk is almost full. A failure (pieces not there yet, a file
 *   ffmpeg can't read) waits 2 minutes before the next try.
 * - Saving a position never waits for any of this.
 */

const log = logger.child({ module: "thumbnails" });

export const THUMBNAIL_WIDTH = 480;
/** ffmpeg's JPEG quality scale: 2 (best) … 31 (worst). */
export const THUMBNAIL_QUALITY = 4;
/** A new frame once the saved position moved this far (s) from the old one. */
export const THUMBNAIL_REFRESH_SECONDS = 5 * 60;
export const THUMBNAIL_TIMEOUT_MS = 20_000;
/** After a failed attempt, the next save waits this long before trying again. */
export const THUMBNAIL_RETRY_MS = 2 * 60_000;
/** A 480 px JPEG is ~30 KB; anything near this is wrong. */
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
/** What the JPEG comment starts with. */
const POSITION_COMMENT = "streamy-position=";

export type ThumbnailDeps = {
  ffmpegPath(): string;
  library: Pick<LibraryStore, "thumbnailPath" | "getFileProgress">;
  /** A URL ffmpeg reads the file with. Throws when it can't be read now. */
  openInput(infoHash: string, fileIndex: number): InternalFileUrl;
  /** false = not now (the disk is almost full). */
  canRun(): boolean;
  now?: () => number;
  timeoutMs?: number;
};

export type ThumbnailMaker = {
  /**
   * A position was saved: makes the file's thumbnail (or a newer one) in the
   * background when it needs one. Quick, and never throws.
   */
  consider(progress: ProgressEntry): void;
  /** The file (or the whole torrent) was forgotten: drop what's planned. */
  forget(infoHash: string, fileIndex?: number): void;
  /** Resolves once nothing is queued or running (tests). */
  idle(): Promise<void>;
  /** Kills a running ffmpeg and drops the queue. Nothing runs after this. */
  shutdown(): Promise<void>;
};

type Job = {
  infoHash: string;
  fileIndex: number;
  position: number;
  duration: number | null;
};

// ─── The position inside the JPEG ────────────────────────────────────────────

/** JPEG segments before the image data: [marker, start, end) of each. */
function* headerSegments(
  bytes: Uint8Array,
): Generator<{ marker: number; start: number; end: number }> {
  let offset = 2; // after SOI (FF D8)
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xda) return; // start of scan: the image data follows
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    const end = offset + 2 + length;
    yield { marker, start: offset, end };
    offset = end;
  }
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** The JPEG with "streamy-position=<s>" in a comment, after its JFIF header. */
export function withPositionComment(jpeg: Buffer, position: number): Buffer {
  const text = Buffer.from(`${POSITION_COMMENT}${position.toFixed(3)}`);
  const header = Buffer.from([0xff, 0xfe, 0, 0]);
  header.writeUInt16BE(text.length + 2, 2);
  // JFIF wants its APP0 right after SOI: the comment goes after it.
  const first = headerSegments(jpeg).next();
  const at = !first.done && first.value.marker === 0xe0 ? first.value.end : 2;
  return Buffer.concat([jpeg.subarray(0, at), header, text, jpeg.subarray(at)]);
}

/** The position a thumbnail shows, or null (no file, or not one of ours). */
export function positionOf(jpeg: Uint8Array): number | null {
  if (!isJpeg(jpeg)) return null;
  for (const { marker, start, end } of headerSegments(jpeg)) {
    if (marker !== 0xfe) continue;
    const text = Buffer.from(jpeg.subarray(start + 4, end)).toString("latin1");
    if (!text.startsWith(POSITION_COMMENT)) continue;
    const value = Number(text.slice(POSITION_COMMENT.length));
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** Reads only the head of the file: the comment is near the start. */
async function readPosition(path: string): Promise<number | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return positionOf(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Replaces the file in one step: a reader never sees half a picture. */
async function writeAtomically(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temp, bytes);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────

/**
 * Where to grab the frame: the saved position, kept a second off the end
 * (seeking past the last frame gives nothing).
 */
export function seekPosition(
  position: number,
  duration: number | null,
): number {
  const latest = duration !== null && duration > 1 ? duration - 1 : Infinity;
  return Math.max(0, Math.min(position, latest));
}

/**
 * One frame at movie time `at` (input -ss counts from the file's start
 * time), 480 px wide, as JPEG bytes on stdout.
 */
export function thumbnailArgs(input: string, at: number): string[] {
  // prettier-ignore
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    // Only real video containers, only our loopback URL.
    ...torrentInputArgs(),
    // Before -i: jump straight there (Range requests), don't decode up to it.
    "-ss", at.toFixed(3),
    "-i", input,
    // The first real video stream (not cover art).
    "-map", "0:V:0", "-an", "-sn", "-dn",
    "-frames:v", "1",
    "-vf", `scale=${THUMBNAIL_WIDTH}:-2`,
    "-q:v", String(THUMBNAIL_QUALITY),
    "-f", "image2pipe", "-c:v", "mjpeg",
    "pipe:1",
  ];
}

function lowerPriority(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    setPriority(child.pid, constants.priority.PRIORITY_LOW);
  } catch {
    // Not allowed here: it's short anyway.
  }
}

// ─── The maker ───────────────────────────────────────────────────────────────

export function createThumbnailMaker(deps: ThumbnailDeps): ThumbnailMaker {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? THUMBNAIL_TIMEOUT_MS;
  /** Waiting to run, newest position per file. */
  const pending = new Map<string, Job>();
  /** The position each file's thumbnail shows (null = none); learned lazily. */
  const shown = new Map<string, number | null>();
  /** No new attempt for a file before this time (after a failure). */
  const retryAt = new Map<string, number>();
  let runningKey: string | null = null;
  let runningChild: ChildProcess | null = null;
  let draining: Promise<void> | null = null;
  let closed = false;

  const keyOf = (infoHash: string, fileIndex: number) =>
    `${infoHash}:${fileIndex}`;

  function isCurrent(made: number | null | undefined, position: number) {
    return (
      made !== undefined &&
      made !== null &&
      Math.abs(position - made) < THUMBNAIL_REFRESH_SECONDS
    );
  }

  async function grabFrame(input: string, at: number): Promise<Buffer> {
    let result;
    try {
      result = await runProcess(deps.ffmpegPath(), thumbnailArgs(input, at), {
        timeoutMs,
        maxStdoutBytes: MAX_JPEG_BYTES,
        onSpawn: (child) => {
          runningChild = child;
          lowerPriority(child);
          if (closed) child.kill("SIGKILL");
        },
      });
    } finally {
      runningChild = null;
    }
    if (result.timedOut) throw new Error("ffmpeg took too long");
    if (result.code !== 0 || !isJpeg(result.stdout)) {
      const why = lastLines(result.stderr, 2).join(" ") || "no picture";
      throw new Error(`ffmpeg failed (${result.code}): ${why}`);
    }
    return result.stdout;
  }

  async function make(key: string, job: Job): Promise<void> {
    const { infoHash, fileIndex, position } = job;
    const path = deps.library.thumbnailPath(infoHash, fileIndex);
    if (!shown.has(key)) shown.set(key, await readPosition(path));
    if (isCurrent(shown.get(key), position) || !deps.canRun()) return;

    let input: InternalFileUrl;
    try {
      input = deps.openInput(infoHash, fileIndex);
    } catch {
      return; // Not active anymore: the next save looks again.
    }
    try {
      const jpeg = await grabFrame(
        input.url,
        seekPosition(position, job.duration),
      );
      // Forgotten while ffmpeg ran: leave nothing behind.
      if (closed || deps.library.getFileProgress(infoHash, fileIndex) === null)
        return;
      await writeAtomically(path, withPositionComment(jpeg, position));
      shown.set(key, position);
      retryAt.delete(key);
      log.debug({ infoHash, fileIndex, position }, "Thumbnail made");
    } catch (err) {
      if (closed) return;
      retryAt.set(key, now() + THUMBNAIL_RETRY_MS);
      log.info({ err, infoHash, fileIndex }, "Couldn't make a thumbnail");
    } finally {
      input.revoke();
    }
  }

  async function drain(): Promise<void> {
    for (;;) {
      const next = pending.entries().next();
      if (closed || next.done) return;
      const [key, job] = next.value;
      pending.delete(key);
      runningKey = key;
      try {
        await make(key, job);
      } catch (err) {
        // E.g. the library was closed meanwhile.
        log.warn({ err }, "Thumbnail job failed");
      } finally {
        runningKey = null;
      }
    }
  }

  function kick(): void {
    draining ??= drain().finally(() => {
      draining = null;
      // Queued in the moment between the loop ending and this.
      if (pending.size > 0 && !closed) kick();
    });
  }

  async function idle(): Promise<void> {
    while (draining) await draining;
  }

  return {
    consider(entry) {
      if (closed || entry.watched) return;
      if (entry.position <= CONTINUE_WATCHING_MIN_POSITION) return;
      const key = keyOf(entry.infoHash, entry.fileIndex);
      const job: Job = {
        infoHash: entry.infoHash,
        fileIndex: entry.fileIndex,
        position: entry.position,
        duration: entry.duration,
      };
      // Already waiting: it'll use the newest position.
      if (pending.has(key)) {
        pending.set(key, job);
        return;
      }
      if (runningKey === key || isCurrent(shown.get(key), entry.position)) {
        return;
      }
      if ((retryAt.get(key) ?? 0) > now()) return;
      pending.set(key, job);
      kick();
    },

    forget(infoHash, fileIndex) {
      const matches = (key: string) =>
        fileIndex === undefined
          ? key.startsWith(`${infoHash}:`)
          : key === keyOf(infoHash, fileIndex);
      for (const map of [pending, shown, retryAt]) {
        for (const key of map.keys()) if (matches(key)) map.delete(key);
      }
    },

    idle,

    async shutdown() {
      closed = true;
      pending.clear();
      runningChild?.kill("SIGKILL");
      await idle();
    },
  };
}
