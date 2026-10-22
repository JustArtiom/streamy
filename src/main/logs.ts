import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type DestinationStream, type Logger, pino } from "pino";
import { redact } from "../shared/redact";
import { isErrnoCode } from "./storage/json-file";

export type { Logger } from "pino";

// main.log: what the main process has to say about the engine (starts,
// exits, restarts, its stderr) and other rare events. One small JSON object
// per line (pino's format, like the engine's engine.log).
//
// Never log the engine secret, tokens, full magnet links (an info hash at
// most) or file names: people attach these files to bug reports. As a safety
// net, every line goes through redact() (like the engine's log), and errors
// lose the file paths Node puts in them (see serializeError).

/** A log file over this size is set aside when Streamy starts. */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** Old files kept: main.log.1 (newest) to main.log.3 (oldest). */
export const OLD_LOGS_KEPT = 3;

interface RotateOptions {
  maxBytes?: number;
  keep?: number;
}

/**
 * Renames `file` to `file.1` (and `file.1` to `file.2`…, dropping the
 * oldest) if it's bigger than `maxBytes`. Run once at startup, before
 * anything writes to it.
 */
export function rotateLogFile(
  file: string,
  { maxBytes = MAX_LOG_BYTES, keep = OLD_LOGS_KEPT }: RotateOptions = {},
): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return; // Nothing logged yet.
    throw error;
  }
  if (size <= maxBytes) return;

  rmSync(`${file}.${keep}`, { force: true });
  for (let n = keep - 1; n >= 1; n--) {
    try {
      renameSync(`${file}.${n}`, `${file}.${n + 1}`);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    }
  }
  renameSync(file, `${file}.1`);
}

/** What a path in an error's message or stack is replaced with. */
const HIDDEN_PATH = "[path]";

/** The file paths an error (or one of its causes) is about. */
function errorPaths(error: unknown, seen = new Set<unknown>()): string[] {
  if (typeof error !== "object" || error === null || seen.has(error)) return [];
  seen.add(error);
  const fields = error as { path?: unknown; dest?: unknown; cause?: unknown };
  const own = [fields.path, fields.dest].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  const nested = error instanceof AggregateError ? error.errors : [];
  return [
    ...own,
    ...errorPaths(fields.cause, seen),
    ...nested.flatMap((inner: unknown) => errorPaths(inner, seen)),
  ];
}

/** Removes `path`/`dest` from a serialized error and cuts `paths` out of its text. */
function scrubSerialized(value: unknown, paths: readonly string[]): void {
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  delete record.path;
  delete record.dest;
  for (const key of ["message", "stack"]) {
    const text = record[key];
    if (typeof text !== "string") continue;
    record[key] = paths.reduce(
      (result, path) => result.split(path).join(HIDDEN_PATH),
      text,
    );
  }
  const inner = record.aggregateErrors;
  if (Array.isArray(inner)) {
    for (const item of inner) scrubSerialized(item, paths);
  }
}

/**
 * pino's error serializer, without file paths. Node's file errors carry the
 * path they were about (`path`, and `dest` for a copy or rename), and repeat
 * it in their message: a video folder or a .torrent file's name says what
 * someone watches.
 */
export function serializeError(error: unknown): unknown {
  const serialized: unknown = pino.stdSerializers.err(error as Error);
  if (serialized === error) return error; // Not an error: left as it is.
  // Longest first, so a folder never leaves part of a file path behind.
  const paths = [...new Set(errorPaths(error))].sort(
    (a, b) => b.length - a.length,
  );
  scrubSerialized(serialized, paths);
  return serialized;
}

const pinoOptions = (level: string): pino.LoggerOptions => ({
  level,
  // No host name: it often contains the user's name.
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: { err: serializeError },
  // A safety net in case an object with these fields ever gets logged.
  redact: {
    paths: ["secret", "*.secret", "token", "*.token", "magnet", "*.magnet"],
    censor: "[hidden]",
  },
});

/** Runs every line through redact() before it's written. */
function redacting(destination: DestinationStream): DestinationStream {
  return {
    write: (line: string) => {
      destination.write(redact(line));
    },
  };
}

/**
 * The main process's logger, writing to `<logsDir>/main.log`. If that file
 * can't be opened, it logs to stderr instead: logging must never stop the
 * app from starting.
 */
export function createMainLogger(logsDir: string, level = "info"): Logger {
  const file = join(logsDir, "main.log");
  try {
    mkdirSync(logsDir, { recursive: true });
    try {
      rotateLogFile(file);
    } catch (error) {
      console.warn("[logs] Could not rotate main.log:", error);
    }
    // Synchronous writes: main logs little, and nothing is lost if the app
    // crashes right after.
    return pino(
      pinoOptions(level),
      redacting(pino.destination({ dest: file, sync: true })),
    );
  } catch (error) {
    console.warn(`[logs] Could not open ${file}, logging to stderr:`, error);
    return pino(pinoOptions(level), redacting(pino.destination(2)));
  }
}

/** A logger that drops everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
