import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type UtilityProcess, utilityProcess } from "electron";
import type { EngineStatus } from "../../shared/api";
import {
  ENGINE_READY_TIMEOUT_MS,
  ENGINE_SHUTDOWN_TIMEOUT_MS,
  type EngineConfig,
  type EngineInitMessage,
  type MainToEngineMessage,
} from "../../shared/engine-protocol";
import { registerSecret } from "../../shared/redact";
import type { Logger } from "../logs";
import { isErrnoCode } from "../storage/json-file";

// Runs the engine (src/engine) in a utilityProcess and keeps it running
// (PLAN §3.4, §5.2):
// - start: fork, send `init` with a fresh secret, wait for `ready { port }`;
// - crashes: start again after 1 s, 2 s, then 5 s. Three crashes within a
//   minute → "failed", and one more try a minute later;
// - ffmpeg/ffprobe it reported as running are killed when it dies (on macOS
//   and Linux they would outlive it);
// - quit: `shutdown`, then kill it if it doesn't exit in time.
//
// The status the UI gets (EngineStatus) only ever holds the fixed sentences
// below: what the engine itself says went wrong goes to main.log.

/** Wait before starting again after the 1st, 2nd and 3rd+ crash in a row. */
export const RESTART_DELAYS_MS = [1_000, 2_000, 5_000] as const;
/** This many crashes within CRASH_WINDOW_MS means "failed". */
export const CRASHES_UNTIL_FAILED = 3;
export const CRASH_WINDOW_MS = 60_000;
/** After "failed", how long until the next try. */
export const FAILED_RETRY_MS = 60_000;
/** Running this long without a crash resets the restart delays. */
export const STABLE_AFTER_MS = 60_000;
/** After kill(), how long until SIGKILL (a process may ignore SIGTERM). */
export const KILL_GRACE_MS = 2_000;

/** How to reach a running engine. */
export interface EngineConnection {
  port: number;
  /** Goes in ENGINE_SECRET_HEADER on every request. Never log it. */
  secret: string;
}

/** What `init` carries, apart from the secret (made by the host). */
export type EngineInit = Omit<EngineInitMessage, "type" | "secret">;

export interface EngineHostOptions {
  /** The engine's built entry file (see entry.ts). */
  entryPath: string;
  /** Called before every start, so a restart gets the current settings. */
  init: () => EngineInit;
  log: Logger;
  /** Ends a process (a leftover ffmpeg/ffprobe, a hung engine). Replaced in tests. */
  killPid?: (pid: number) => void;
}

type StatusListener = (status: EngineStatus) => void;

/** One engine process, from fork to exit. */
interface Run {
  child: UtilityProcess;
  secret: string;
  /** Set by `ready`. */
  port: number | null;
  /** It didn't send `ready` in time, and was killed for it. */
  tooSlow: boolean;
  /** ffmpeg/ffprobe pids it said are running. */
  childPids: Set<number>;
  readyTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  /** Called once the process has exited. */
  onExit: (() => void)[];
}

interface Waiter {
  resolve: (connection: EngineConnection) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const STOPPED_UNEXPECTEDLY = "The playback engine stopped unexpectedly.";
const COULD_NOT_START = "The playback engine couldn't start.";
const TOO_SLOW = "The playback engine took too long to start.";
/** Longest line from the engine's stdout/stderr kept in main.log. */
const MAX_OUTPUT_LINE = 2_000;

/** Longest `fatal` text from the engine kept in main.log. */
const MAX_FATAL_LENGTH = 2_000;

/** Executable names the engine runs (see src/engine/media). */
const MEDIA_PROCESS_NAMES = new Set(["ffmpeg.exe", "ffprobe.exe"]);

/**
 * The image name of a running Windows process ("ffmpeg.exe"), or null if
 * there's no such process. One CSV line from tasklist:
 * "ffmpeg.exe","1234","Console","1","12,345 K"
 */
export function parseTasklistImage(output: string): string | null {
  const match = /^"([^"]+)","(\d+)"/m.exec(output.trim());
  return match?.[1] ?? null;
}

/**
 * Ends a process. A leftover ffmpeg/ffprobe (`media`) is a pid the engine
 * reported: on Windows a pid can go to a new process soon after the old one
 * ends, so it first checks the pid still belongs to ffmpeg or ffprobe
 * (tasklist ships with every Windows). Elsewhere pids are handed out in
 * order and only come round again much later.
 */
function defaultKillPid(pid: number, media: boolean, log: Logger): void {
  if (!media || process.platform !== "win32") {
    process.kill(pid, "SIGKILL");
    return;
  }
  const tasklist = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "tasklist.exe",
  );
  execFile(
    tasklist,
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { windowsHide: true, timeout: 5_000 },
    (error, stdout) => {
      if (error) {
        log.warn({ pid, err: error }, "Could not check a leftover process");
        return;
      }
      const image = parseTasklistImage(stdout)?.toLowerCase() ?? null;
      if (image === null) return; // Already gone.
      if (!MEDIA_PROCESS_NAMES.has(image)) {
        log.info(
          { pid, image },
          "A leftover pid now belongs to another program",
        );
        return;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch (killError) {
        if (!isErrnoCode(killError, "ESRCH")) {
          log.warn({ pid, err: killError }, "Could not kill a process");
        }
      }
    },
  );
}

export class EngineHost {
  readonly #options: EngineHostOptions;
  readonly #killPid: (pid: number, media: boolean) => void;
  readonly #listeners = new Set<StatusListener>();
  readonly #waiters = new Set<Waiter>();
  #status: EngineStatus = { state: "starting", error: null };
  #run: Run | null = null;
  #started = false;
  #stopping: Promise<void> | null = null;
  /** Times of recent crashes (for "three within a minute"). */
  #crashTimes: number[] = [];
  /** Crashes since the engine last ran for STABLE_AFTER_MS. */
  #crashesInARow = 0;
  #restartTimer?: NodeJS.Timeout;
  #stableTimer?: NodeJS.Timeout;

  constructor(options: EngineHostOptions) {
    this.#options = options;
    const { killPid, log } = options;
    this.#killPid = killPid
      ? (pid) => {
          killPid(pid);
        }
      : (pid, media) => {
          defaultKillPid(pid, media, log);
        };
  }

  /** Starts the engine. Call once, after the app is ready. */
  start(): void {
    if (this.#started || this.#stopping) return;
    this.#started = true;
    this.#launch();
  }

  status(): EngineStatus {
    return { ...this.#status };
  }

  /** Calls `listener` after every status change. Returns an unsubscribe function. */
  onStatusChange(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** How to reach the engine, or null while it isn't running. */
  connection(): EngineConnection | null {
    const run = this.#run;
    if (!run || run.port === null || this.#stopping) return null;
    return { port: run.port, secret: run.secret };
  }

  /**
   * Resolves once the engine is running (right away if it is). Rejects if it
   * fails to start ("failed"), if Streamy quits, or after `timeoutMs`.
   */
  whenRunning(timeoutMs: number): Promise<EngineConnection> {
    const connection = this.connection();
    if (connection) return Promise.resolve(connection);
    if (this.#stopping)
      return Promise.reject(new Error("Streamy is quitting."));
    if (this.#status.state === "failed") {
      return Promise.reject(new Error(this.#failedMessage()));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("The playback engine isn't running yet."));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  /** Sends changed settings to the engine (a new start gets them in `init`). */
  configure(config: EngineConfig): void {
    const run = this.#run;
    if (run && !this.#stopping) this.#send(run, { type: "config", config });
  }

  /** True while an engine process exists (so quitting has to wait for it). */
  get hasProcess(): boolean {
    return this.#run !== null;
  }

  /**
   * Asks the engine to stop (it stops ffmpeg, closes torrents and its
   * library), kills it if it doesn't exit in time, and never starts it again.
   * Safe to call more than once; always settles.
   *
   * The status stops saying "running" ("restarting", with no error): the
   * only window that can still see it is the one of "Restart to update",
   * and Streamy is about to start again there.
   */
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    clearTimeout(this.#restartTimer);
    clearTimeout(this.#stableTimer);
    this.#rejectWaiters(new Error("Streamy is quitting."));
    if (this.#status.state === "running") {
      this.#setStatus({ state: "restarting", error: null });
    }

    const run = this.#run;
    if (!run) {
      this.#stopping = Promise.resolve();
      return this.#stopping;
    }
    this.#stopping = new Promise<void>((resolve) => {
      // Whatever happens, quitting never waits longer than this.
      const giveUp = setTimeout(
        () => {
          this.#options.log.error(
            "Engine still hasn't exited; quitting anyway",
          );
          clearTimeout(run.killTimer);
          this.#killLeftovers(run);
          resolve();
        },
        ENGINE_SHUTDOWN_TIMEOUT_MS + KILL_GRACE_MS + 1_000,
      );
      const timeout = setTimeout(() => {
        this.#options.log.warn("Engine didn't stop in time; killing it");
        this.#terminate(run);
      }, ENGINE_SHUTDOWN_TIMEOUT_MS);
      run.onExit.push(() => {
        clearTimeout(timeout);
        clearTimeout(giveUp);
        resolve();
      });
      this.#options.log.info("Stopping the engine");
      if (!this.#send(run, { type: "shutdown" })) this.#terminate(run);
    });
    return this.#stopping;
  }

  #launch(): void {
    const { log, entryPath } = this.#options;
    const secret = randomBytes(32).toString("hex");
    // main.log never shows it, whatever ends up being logged.
    registerSecret(secret);
    let child: UtilityProcess;
    let init: EngineInit;
    try {
      init = this.#options.init();
      child = utilityProcess.fork(entryPath, [], {
        serviceName: "Streamy Engine",
        stdio: "pipe",
      });
    } catch (error) {
      log.error({ err: error }, "Could not start the engine");
      this.#crashed(COULD_NOT_START);
      return;
    }

    const run: Run = {
      child,
      secret,
      port: null,
      tooSlow: false,
      childPids: new Set(),
      onExit: [],
    };
    this.#run = run;
    log.info({ entryPath }, "Starting the engine");

    child.on("message", (message: unknown) => {
      this.#onMessage(run, message);
    });
    child.once("exit", (code) => {
      this.#onExit(run, code);
    });
    // A V8 fatal error. "exit" always follows, which handles it.
    child.on("error", (type, location) => {
      log.error({ type, location }, "Engine fatal error");
    });
    pipeLines(child.stdout, (line) => {
      log.info({ engine: "stdout" }, line);
    });
    pipeLines(child.stderr, (line) => {
      log.warn({ engine: "stderr" }, line);
    });

    run.readyTimer = setTimeout(() => {
      log.error(
        { timeoutMs: ENGINE_READY_TIMEOUT_MS },
        "Engine didn't get ready in time",
      );
      run.tooSlow = true;
      this.#terminate(run);
    }, ENGINE_READY_TIMEOUT_MS);

    this.#send(run, { type: "init", secret, ...init });
  }

  #onMessage(run: Run, message: unknown): void {
    const { log } = this.#options;
    if (typeof message !== "object" || message === null) {
      log.warn("Engine sent a message that isn't an object");
      return;
    }
    const data = message as Record<string, unknown>;
    switch (data.type) {
      case "ready": {
        const { port } = data;
        if (
          typeof port !== "number" ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65_535
        ) {
          log.error({ port }, "Engine sent `ready` with a bad port");
          return;
        }
        if (run !== this.#run || run.port !== null || this.#stopping) return;
        clearTimeout(run.readyTimer);
        run.port = port;
        log.info({ port }, "Engine is running");
        // Only a run that lasts a while counts as recovered.
        this.#stableTimer = setTimeout(() => {
          this.#crashesInARow = 0;
        }, STABLE_AFTER_MS);
        this.#setStatus({ state: "running", error: null });
        const connection = { port, secret: run.secret };
        for (const waiter of this.#waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(connection);
        }
        this.#waiters.clear();
        return;
      }
      case "child": {
        const { pid, alive } = data;
        if (
          typeof pid !== "number" ||
          !Number.isInteger(pid) ||
          pid <= 0 ||
          typeof alive !== "boolean"
        ) {
          log.warn({ pid, alive }, "Engine sent a bad `child` message");
          return;
        }
        if (alive) run.childPids.add(pid);
        else run.childPids.delete(pid);
        return;
      }
      case "fatal": {
        // Raw error text (a stack trace, a file path…): for the log only.
        // The UI gets one of the fixed sentences when the engine exits.
        const text =
          typeof data.message === "string"
            ? data.message.trim().slice(0, MAX_FATAL_LENGTH)
            : "";
        log.error({ fatal: text || null }, "Engine reported a fatal error");
        return;
      }
      default:
        log.warn({ type: data.type }, "Engine sent an unknown message");
    }
  }

  #onExit(run: Run, code: number): void {
    const { log } = this.#options;
    clearTimeout(run.readyTimer);
    clearTimeout(run.killTimer);
    this.#killLeftovers(run);
    if (this.#run === run) this.#run = null;
    for (const callback of run.onExit.splice(0)) callback();

    if (this.#stopping) {
      log.info({ code }, "Engine stopped");
      return;
    }
    log.error({ code }, "Engine exited unexpectedly");
    // Exiting before `ready` is a failed start. (What the engine said in its
    // `fatal` message, if it arrived, is in the log.)
    this.#crashed(
      run.tooSlow
        ? TOO_SLOW
        : run.port === null
          ? COULD_NOT_START
          : STOPPED_UNEXPECTEDLY,
    );
  }

  /** The engine is gone when it shouldn't be: start it again, or give up for a while. */
  #crashed(error: string): void {
    const { log } = this.#options;
    clearTimeout(this.#stableTimer);
    const now = Date.now();
    this.#crashTimes = [
      ...this.#crashTimes.filter((time) => now - time < CRASH_WINDOW_MS),
      now,
    ];
    this.#crashesInARow++;

    if (this.#crashTimes.length >= CRASHES_UNTIL_FAILED) {
      log.error(
        { retryInMs: FAILED_RETRY_MS },
        "Engine keeps stopping; trying again later",
      );
      this.#setStatus({ state: "failed", error });
      this.#rejectWaiters(new Error(this.#failedMessage()));
      this.#restartTimer = setTimeout(() => {
        this.#crashTimes = [];
        this.#crashesInARow = 0;
        this.#setStatus({ state: "restarting", error });
        this.#launch();
      }, FAILED_RETRY_MS);
      return;
    }

    const delay =
      RESTART_DELAYS_MS[
        Math.min(this.#crashesInARow, RESTART_DELAYS_MS.length) - 1
      ] ?? RESTART_DELAYS_MS[0];
    log.info({ delayMs: delay }, "Restarting the engine");
    this.#setStatus({ state: "restarting", error });
    this.#restartTimer = setTimeout(() => {
      this.#launch();
    }, delay);
  }

  /** kill(), then SIGKILL if the process is still there after a moment. */
  #terminate(run: Run): void {
    if (run.killTimer) return;
    try {
      run.child.kill();
    } catch (error) {
      this.#options.log.warn({ err: error }, "Could not kill the engine");
    }
    run.killTimer = setTimeout(() => {
      const { pid } = run.child;
      if (pid === undefined) return;
      this.#options.log.warn({ pid }, "Engine ignored kill(); sending SIGKILL");
      this.#killQuietly(pid, false);
    }, KILL_GRACE_MS);
  }

  /** Kills the ffmpeg/ffprobe processes a dead engine left behind. */
  #killLeftovers(run: Run): void {
    for (const pid of run.childPids) {
      this.#options.log.warn(
        { pid },
        "Killing a leftover engine child process",
      );
      this.#killQuietly(pid, true);
    }
    run.childPids.clear();
  }

  #killQuietly(pid: number, media: boolean): void {
    try {
      this.#killPid(pid, media);
    } catch (error) {
      // Already gone: fine.
      if (!isErrnoCode(error, "ESRCH")) {
        this.#options.log.warn({ pid, err: error }, "Could not kill a process");
      }
    }
  }

  /** Sends a message to the engine. False if it can't take messages anymore. */
  #send(run: Run, message: MainToEngineMessage): boolean {
    try {
      run.child.postMessage(message);
      return true;
    } catch (error) {
      this.#options.log.warn(
        { err: error, type: message.type },
        "Could not send a message to the engine",
      );
      return false;
    }
  }

  #setStatus(status: EngineStatus): void {
    if (
      status.state === this.#status.state &&
      status.error === this.#status.error
    ) {
      return;
    }
    this.#status = status;
    for (const listener of this.#listeners) listener(this.status());
  }

  #failedMessage(): string {
    return this.#status.error ?? STOPPED_UNEXPECTEDLY;
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

/** Calls `onLine` for each non-empty line of a process's output. */
function pipeLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return;
  // Closes by itself when the stream ends (the process exited).
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    onLine(
      line.length > MAX_OUTPUT_LINE
        ? `${line.slice(0, MAX_OUTPUT_LINE)}…`
        : line,
    );
  });
}
