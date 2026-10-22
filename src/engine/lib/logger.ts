import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type DestinationStream, type Logger, pino } from "pino";
import type { LogLevel } from "../../shared/engine-protocol";
import { redact } from "../../shared/redact";

/*
 * The engine's logger: pino, JSON lines, written to <logsDir>/engine.log.
 *
 * - No pino transports and no pino-pretty: those run in worker threads that
 *   load files by path, which breaks inside a packaged app.asar. We write
 *   with pino.destination (sonic-boom) on the main thread instead.
 * - Modules create their child loggers at import time, before the init
 *   message says where to write. So the logger exists from the start
 *   (silent, writing nowhere) and openLogFile() points it at the file later.
 *   Children follow the root's level (pino children inherit it).
 * - Every line goes through redact(): no secret, file token or full magnet
 *   link can end up in the file.
 * - Errors (`err`) are logged without the file paths they carry
 *   (serializeError): those name files inside torrents, which say what
 *   someone watches.
 */

/** Hands each line to the log file once one is open; drops them before. */
class LogSink implements DestinationStream {
  target: ReturnType<typeof pino.destination> | null = null;

  write(line: string): void {
    this.target?.write(redact(line));
  }
}

const sink = new LogSink();

/** A quoted absolute path in an error message: open '/Users/…/Movie.mkv'. */
const QUOTED_PATH = /'(?:[A-Za-z]:)?[\\/][^']*'/g;

function isErrorLike(value: unknown): value is Error {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** The `path` and `dest` of an fs error, its causes and its inner errors. */
function pathsOf(
  err: unknown,
  found = new Set<string>(),
  seen = new Set<object>(),
): Set<string> {
  if (typeof err !== "object" || err === null || seen.has(err)) return found;
  seen.add(err);
  const { path, dest, cause, errors } = err as Record<string, unknown>;
  for (const value of [path, dest]) {
    if (typeof value === "string" && value.length > 0) found.add(value);
  }
  pathsOf(cause, found, seen);
  if (Array.isArray(errors)) {
    for (const inner of errors) pathsOf(inner, found, seen);
  }
  return found;
}

/**
 * A copy of `value` without `path`/`dest` keys, and with those paths (and
 * any quoted absolute path) cut out of every text in it. Plain data only:
 * a few levels deep is all an error needs.
 */
function withoutPaths(value: unknown, paths: Set<string>, depth = 0): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const path of paths) text = text.replaceAll(path, "[path]");
    return text.replace(QUOTED_PATH, "'[path]'");
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 4) return "[…]";
  if (Array.isArray(value)) {
    return value.map((inner) => withoutPaths(inner, paths, depth + 1));
  }
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "path" || key === "dest") continue;
    copy[key] = withoutPaths(inner, paths, depth + 1);
  }
  return copy;
}

/**
 * pino's error serializer, minus file paths: an fs error's `path` and
 * `dest`, and the same paths in its message and stack ("ENOENT: no such
 * file or directory, open '/…/Movie.mkv'"). Also takes an error pino-http
 * already serialized (it keeps the original as `raw`).
 */
export function serializeError(err: unknown): unknown {
  if (!isErrorLike(err)) return err;
  const serialized: unknown = "raw" in err ? err : pino.stdSerializers.err(err);
  const raw = (serialized as { raw?: unknown }).raw ?? err;
  return withoutPaths(serialized, pathsOf(raw));
}

export const logger: Logger = pino(
  {
    level: "silent",
    // No hostname: people attach logs to bug reports.
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: serializeError },
  },
  sink,
);

export const LOG_FILE_NAME = "engine.log";
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const OLD_LOGS_KEPT = 3;

/**
 * engine.log over `maxBytes` → engine.log.1 (and .1 → .2 …, the oldest
 * dropped). Done once at start, so a file never grows past one run's worth.
 */
export async function rotateLogFile(
  file: string,
  { maxBytes = MAX_LOG_BYTES, keep = OLD_LOGS_KEPT } = {},
): Promise<void> {
  const size = await stat(file).then(
    (info) => info.size,
    () => 0,
  );
  if (size <= maxBytes) return;

  await rm(`${file}.${keep}`, { force: true });
  for (let n = keep - 1; n >= 1; n--) {
    await rename(`${file}.${n}`, `${file}.${n + 1}`).catch(ignoreMissing);
  }
  await rename(file, `${file}.1`);
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

/** Starts writing to <dir>/engine.log at `level`. Returns the file's path. */
export async function openLogFile(options: {
  dir: string;
  level: LogLevel;
}): Promise<string> {
  await mkdir(options.dir, { recursive: true });
  const file = join(options.dir, LOG_FILE_NAME);
  await rotateLogFile(file);

  closeLogFile();
  const destination = pino.destination({
    dest: file,
    sync: false,
    mkdir: true,
  });
  // A log that can't be written (disk full, permissions) must never take
  // the engine down: say it once on stderr (main keeps that) and stop.
  destination.on("error", (error: unknown) => {
    if (sink.target !== destination) return;
    sink.target = null;
    process.stderr.write(`engine.log can't be written: ${String(error)}\n`);
  });
  // Opened, so flushLog() can write synchronously from now on (it can't
  // before: the last lines before a fast exit would be lost).
  await new Promise<void>((resolve, reject) => {
    destination.once("ready", resolve);
    destination.once("error", reject);
  });
  sink.target = destination;
  logger.level = options.level;
  return file;
}

/** Writes out what's buffered, right now (before exiting). */
export function flushLog(): void {
  try {
    sink.target?.flushSync();
  } catch {
    // Not open yet, or already closed: nothing to flush.
  }
}

/** Flushes and closes the file; the logger goes silent. */
export function closeLogFile(): void {
  const target = sink.target;
  if (!target) return;
  flushLog();
  sink.target = null;
  logger.level = "silent";
  try {
    target.end();
  } catch {
    // Already closed.
  }
}
