import { type ChildProcess, spawn } from "node:child_process";
import { AppError, ErrorCode } from "../http/errors";
import { trackChild } from "./children";

/*
 * Running ffmpeg/ffprobe to completion. Always an args array, never a shell:
 * file names and URLs come from torrents.
 */

export type RunResult = {
  code: number | null;
  stdout: Buffer;
  /** The last lines of stderr (ffmpeg's warnings and errors). */
  stderr: string;
  timedOut: boolean;
};

/** What people see when ffmpeg can't run at all. Details go to the log. */
export const FFMPEG_MISSING_MESSAGE =
  "ffmpeg is missing or can't run. Reinstalling Streamy should fix it.";

export function ffmpegMissingError() {
  return new AppError(ErrorCode.ServiceUnavailable, FFMPEG_MISSING_MESSAGE);
}

/** spawn() failed because the program doesn't exist. */
export function isMissingProgram(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES")
  );
}

/**
 * Variables ffmpeg/ffprobe must not see. A proxy would receive our token
 * URLs (and can't reach 127.0.0.1 anyway, so playback breaks), and
 * FFREPORT writes a log file with them.
 */
const DROPPED_ENV = new Set([
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "ffreport",
]);

/** The engine's environment without the variables above (any letter case: Windows). */
export function ffmpegEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(
      ([name]) => !DROPPED_ENV.has(name.toLowerCase()),
    ),
  );
}

/**
 * What every ffmpeg/ffprobe spawn gets: no console window popping up on
 * Windows, and the cleaned environment.
 */
export function ffmpegSpawnOptions(): {
  windowsHide: true;
  env: NodeJS.ProcessEnv;
} {
  return { windowsHide: true, env: ffmpegEnv() };
}

const MAX_STDERR_CHARS = 8_000;

export function runProcess(
  path: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxStdoutBytes?: number;
    /** Kills it (SIGKILL) when this aborts, e.g. a playback start superseded. */
    signal?: AbortSignal;
    /** Right after it started (e.g. to lower its priority, or kill it later). */
    onSpawn?: (child: ChildProcess) => void;
  },
): Promise<RunResult> {
  const maxStdout = options.maxStdoutBytes ?? 32 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = trackChild(
      spawn(path, args, {
        ...ffmpegSpawnOptions(),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    options.onSpawn?.(child);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const abort = () => child.kill("SIGKILL");
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const done = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    child.on("error", (error) => {
      done();
      reject(isMissingProgram(error) ? ffmpegMissingError() : error);
    });
    child.on("close", (code) => {
      done();
      resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut });
    });
  });
}

/** The last non-empty lines of some ffmpeg output, for logs and error messages. */
export function lastLines(text: string, count: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count);
}
