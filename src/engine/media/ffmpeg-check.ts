import type { Health } from "../../shared/engine-api";
import { getRuntime } from "../config";
import { logger } from "../lib/logger";
import { FFMPEG_MISSING_MESSAGE, lastLines, runProcess } from "./run";

/*
 * At start, the engine checks that ffmpeg and ffprobe run, and which
 * version they are ("8.1.3-Jellyfin"). /v1/health reports it, so Settings
 * can show "ffmpeg 8.1.3", or a plain sentence when it doesn't work (the
 * details, with paths and exit codes, go to the log).
 */

const log = logger.child({ module: "ffmpeg-check" });

let status: Health["ffmpeg"] = { version: null, error: null };
let running: Promise<Health["ffmpeg"]> | null = null;

/** "ffmpeg version 8.1.3-Jellyfin Copyright (c) …" → "8.1.3-Jellyfin". */
export function parseFfmpegVersion(output: string): string | null {
  const match = /^\s*ff(?:mpeg|probe) version (\S+)/m.exec(output);
  return match?.[1] ?? null;
}

async function versionOf(name: string, path: string): Promise<string> {
  let result;
  try {
    result = await runProcess(path, ["-hide_banner", "-version"], {
      timeoutMs: 15_000,
    });
  } catch (error) {
    // runProcess turns "missing" (ENOENT) and "not executable" (EACCES)
    // into one error; anything else is rarer.
    throw new Error(`${name} is missing or can't run: ${path}`, {
      cause: error,
    });
  }
  if (result.timedOut) throw new Error(`${name} didn't answer in time`);
  if (result.code !== 0) {
    const reason = lastLines(result.stderr, 1)[0];
    throw new Error(
      `${name} failed (exit code ${result.code ?? "none"})${reason ? `: ${reason}` : ""}`,
    );
  }
  const version = parseFfmpegVersion(result.stdout.toString("utf8"));
  if (!version) throw new Error(`${name} printed no version`);
  return version;
}

/** Runs the check (once at a time) and remembers the result. */
export function checkFfmpeg(): Promise<Health["ffmpeg"]> {
  running ??= (async () => {
    const { ffmpegPath, ffprobePath } = getRuntime();
    try {
      const [version] = await Promise.all([
        versionOf("ffmpeg", ffmpegPath),
        versionOf("ffprobe", ffprobePath),
      ]);
      status = { version, error: null };
      log.info({ version }, "ffmpeg works");
    } catch (error) {
      status = { version: null, error: FFMPEG_MISSING_MESSAGE };
      log.error({ err: error }, "ffmpeg doesn't work");
    }
    running = null;
    return status;
  })();
  return running;
}

/** The last result; { null, null } while the first check runs. */
export function ffmpegStatus(): Health["ffmpeg"] {
  return status;
}

/** Tests. */
export function resetFfmpegCheckForTests(): void {
  status = { version: null, error: null };
  running = null;
}
