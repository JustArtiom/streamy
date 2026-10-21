import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// Small JSON files (settings, window position). They're read once at startup
// and written rarely, so this is synchronous on purpose: every write is done
// before anything else runs, so there are no races and nothing is left
// half-saved when the app quits.

export function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}

// On Windows, antivirus, backup or search indexing can lock a file for a
// moment. These errors are worth a few quick retries.
const RETRYABLE_CODES = ["EPERM", "EACCES", "EBUSY"];
const ATTEMPTS = 6;

function withRetry<T>(action: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (error) {
      const retryable = RETRYABLE_CODES.some((code) =>
        isErrnoCode(error, code),
      );
      if (!retryable || attempt >= ATTEMPTS) throw error;
      sleep(attempt * 25);
    }
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type ReadResult =
  | { status: "ok"; data: unknown }
  /** No file yet (or a broken one that was moved aside): safe to write. */
  | { status: "missing" }
  /** The file exists but couldn't be read. Don't overwrite it. */
  | { status: "unreadable" };

/**
 * Reads a JSON file. A file with broken JSON is renamed to
 * `<name>.corrupt-<time>` (kept, not deleted) so the app can start fresh.
 */
export function readJsonFile(file: string): ReadResult {
  let text: string;
  try {
    text = withRetry(() => readFileSync(file, "utf8"));
  } catch (error) {
    // ENOTDIR: part of the path is a file, so this file can't exist either.
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return { status: "missing" };
    }
    console.warn(`[storage] Could not read ${file}:`, error);
    return { status: "unreadable" };
  }

  try {
    // Editors like Notepad may add a byte-order mark; JSON.parse rejects it.
    const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return { status: "ok", data: JSON.parse(json) };
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, backup);
      console.warn(`[storage] ${file} was not valid JSON. Moved to ${backup}.`);
      return { status: "missing" };
    } catch (error) {
      console.warn(`[storage] ${file} is not valid JSON:`, error);
      return { status: "unreadable" };
    }
  }
}

/**
 * Saves JSON so that a crash or power cut never leaves a half-written file:
 * write a temporary file next to it, flush it to disk, then swap it in with a
 * rename (which replaces the old file in one step).
 */
export function writeJsonFile(file: string, data: unknown): void {
  const dir = dirname(file);
  const name = basename(file);
  mkdirSync(dir, { recursive: true });
  removeLeftoverTempFiles(dir, name);

  const temp = join(dir, `.${name}.${process.pid}-${Date.now()}.tmp`);
  try {
    const fd = openSync(temp, "w");
    try {
      // writeFileSync (unlike writeSync) keeps going until all of it is written.
      writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    withRetry(() => {
      renameSync(temp, file);
    });
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  syncDirectory(dir);
}

/** Temp files from a save that was cut short (e.g. the app was killed). */
function removeLeftoverTempFiles(dir: string, name: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`.${name}.`) && entry.endsWith(".tmp")) {
      rmSync(join(dir, entry), { force: true });
    }
  }
}

/**
 * Makes the rename itself survive a power cut (macOS/Linux). Best effort:
 * Windows and some file systems can't open folders like this.
 */
function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not supported here; the save itself already succeeded.
  }
}
