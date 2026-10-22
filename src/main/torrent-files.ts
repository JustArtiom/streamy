import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  type BrowserWindow,
  dialog,
  type OpenDialogOptions,
  type WebContents,
} from "electron";
import { IpcChannel, type TorrentFileOpened } from "../shared/api";
import { addTorrentFile, EngineRequestError } from "./engine/client";
import type { EngineHost } from "./engine/host";
import type { Logger } from "./logs";
import { isMagnetLink } from "./magnet-links";
import { isErrnoCode } from "./storage/json-file";
import { sendWhenLoaded } from "./ui-messages";

// .torrent files opened with Streamy from outside (PLAN §7.5): a
// double-click, a drop on the Dock icon, "Open with", or File → Open
// Torrent File…. Main reads the file and adds it to the engine; the UI only
// gets the result. They arrive:
// - macOS: the "open-file" event, even when the file launched the app;
// - Windows/Linux: as command line arguments, of this launch or of a second
//   launch that the single-instance lock forwards to us.

/** The engine refuses bigger .torrent files too. */
export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024;

/** How long a file opened at launch waits for the engine to start. */
const ENGINE_WAIT_MS = 60_000;

/** What was wrong with a .torrent file, for the log (which never gets its name). */
export type TorrentFileProblem =
  | "missing"
  | "not-a-file"
  | "empty"
  | "too-big"
  | "not-allowed"
  | "unreadable"
  | "engine-not-running";

/**
 * A .torrent file Streamy can't use. The message is meant for people (it
 * names the file); `problem` is what goes to the log.
 */
export class TorrentFileError extends Error {
  override name = "TorrentFileError";
  readonly problem: TorrentFileProblem;

  constructor(message: string, problem: TorrentFileProblem) {
    super(message);
    this.problem = problem;
  }
}

const isTorrentName = (name: string) => name.toLowerCase().endsWith(".torrent");

interface ArgvOptions {
  /** Relative paths are relative to this folder. */
  cwd: string;
  platform?: NodeJS.Platform;
}

/**
 * The .torrent file a command line argument names, as an absolute path, or
 * null for anything else (flags, links, other files).
 */
export function torrentFileArgument(
  arg: string,
  { cwd, platform = process.platform }: ArgvOptions,
): string | null {
  if (arg.startsWith("-") || isMagnetLink(arg)) return null;
  let file = arg;
  // Linux file managers may pass file:// URLs. Any other scheme (two or
  // more letters, so not a Windows drive like "C:") isn't a local file.
  if (/^file:/i.test(arg)) {
    try {
      file = fileURLToPath(arg, { windows: platform === "win32" });
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(arg)) {
    return null;
  }
  if (!isTorrentName(file)) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.resolve(cwd, file);
}

/**
 * The .torrent files among command line arguments, as absolute paths.
 * Flags, links and other files are ignored.
 */
export function findTorrentFiles(
  argv: readonly string[],
  options: ArgvOptions,
): string[] {
  const found = new Set<string>();
  for (const arg of argv) {
    const file = torrentFileArgument(arg, options);
    if (file !== null) found.add(file);
  }
  return [...found];
}

/**
 * Reads a .torrent file, refusing anything over MAX_TORRENT_FILE_BYTES
 * without reading it.
 */
export async function readTorrentFile(file: string): Promise<Uint8Array> {
  const name = path.basename(file);
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    throw readError(error, name);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new TorrentFileError(`"${name}" isn't a file.`, "not-a-file");
    }
    if (stats.size === 0) {
      throw new TorrentFileError(`"${name}" is empty.`, "empty");
    }
    if (stats.size > MAX_TORRENT_FILE_BYTES) {
      throw new TorrentFileError(
        `"${name}" is too big to be a torrent file (over 10 MB).`,
        "too-big",
      );
    }
    // Read only what stat promised, even if the file grows meanwhile.
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    if (error instanceof TorrentFileError) throw error;
    throw readError(error, name);
  } finally {
    await handle.close();
  }
}

function readError(error: unknown, name: string): TorrentFileError {
  if (isErrnoCode(error, "ENOENT")) {
    return new TorrentFileError(`"${name}" couldn't be found.`, "missing");
  }
  if (isErrnoCode(error, "EISDIR")) {
    return new TorrentFileError(`"${name}" isn't a file.`, "not-a-file");
  }
  if (isErrnoCode(error, "EACCES") || isErrnoCode(error, "EPERM")) {
    return new TorrentFileError(
      `Streamy isn't allowed to read "${name}".`,
      "not-allowed",
    );
  }
  return new TorrentFileError(`Streamy couldn't read "${name}".`, "unreadable");
}

interface TorrentFileOptions {
  /** Shows the main window (creating it if needed) and returns its contents. */
  showWindow: () => WebContents;
  engine: Pick<EngineHost, "whenRunning">;
  log: Logger;
}

export interface TorrentFiles {
  /** Call once the app can show its window: files received so far are opened. */
  start: () => void;
  /** Hand over the arguments of a launch (see "second-instance"). */
  fromArgv: (argv: readonly string[], cwd: string) => void;
  /** File → Open Torrent File…: asks for a file, then opens it. */
  chooseAndOpen: (window: BrowserWindow | null) => Promise<void>;
}

/**
 * Call before the app is ready: on macOS, a file that launches Streamy
 * arrives before "ready", and would be lost if nobody listened yet.
 */
export function receiveTorrentFiles({
  showWindow,
  engine,
  log,
}: TorrentFileOptions): TorrentFiles {
  const pending: string[] = [];
  let started = false;

  /** Reads the file and adds it to the engine. Never throws. */
  const add = async (file: string): Promise<TorrentFileOpened> => {
    const name = path.basename(file);
    try {
      const bytes = await readTorrentFile(file);
      const connection = await engine.whenRunning(ENGINE_WAIT_MS).catch(() => {
        throw new TorrentFileError(
          `"${name}" couldn't be opened: the playback engine isn't running. Try again in a moment.`,
          "engine-not-running",
        );
      });
      const infoHash = await addTorrentFile(connection, bytes);
      log.info({ infoHash }, "Opened a .torrent file");
      return { status: "ok", infoHash };
    } catch (error) {
      if (error instanceof TorrentFileError) {
        // Its message names the file: only what went wrong is logged.
        log.warn({ problem: error.problem }, "Could not open a .torrent file");
        return { status: "error", message: error.message };
      }
      log.warn({ err: error }, "Could not open a .torrent file");
      if (error instanceof EngineRequestError) {
        return {
          status: "error",
          message: `"${name}" couldn't be opened. ${error.message}`,
        };
      }
      return { status: "error", message: `"${name}" couldn't be opened.` };
    }
  };

  const deliver = (file: string) => {
    // Show the window right away; the result follows when it's ready.
    const contents = showWindow();
    void add(file).then((result) => {
      if (!contents.isDestroyed()) {
        sendWhenLoaded(contents, IpcChannel.TorrentFileOpened, result);
      }
    });
  };

  const receive = (file: string) => {
    if (!isTorrentName(file)) return;
    if (started) deliver(file);
    else pending.push(file);
  };

  app.on("open-file", (event, file) => {
    event.preventDefault();
    receive(file);
  });

  const fromArgv = (argv: readonly string[], cwd: string) => {
    for (const file of findTorrentFiles(argv, { cwd })) receive(file);
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      fromArgv(process.argv, process.cwd()); // Windows/Linux: what launched us
      for (const file of pending.splice(0)) deliver(file);
    },
    fromArgv,
    chooseAndOpen: async (window) => {
      const options: OpenDialogOptions = {
        title: "Open a torrent file",
        buttonLabel: "Open",
        properties: ["openFile"],
        filters: [{ name: "Torrent files", extensions: ["torrent"] }],
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      const file = result.filePaths[0];
      if (!result.canceled && file) receive(file);
    },
  };
}
