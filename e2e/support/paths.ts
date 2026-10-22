import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Where the e2e suite keeps things. Everything it makes goes under .e2e/
// (gitignored), except the throwaway profiles of each test (temp folders).

/** The app's project folder (app/). */
export const APP_DIR = resolve(import.meta.dirname, "../..");

/** The suite's own gitignored folder. */
export const E2E_DIR = join(APP_DIR, ".e2e");

/**
 * The app as Electron runs it: a package.json (made by global-setup.ts)
 * whose `main` points at the build in out/. Kept apart from app/out, so
 * running the suite never replaces the build `npm start` uses.
 */
export const BUILD_DIR = join(E2E_DIR, "build");
export const BUILD_MAIN = join(BUILD_DIR, "out", "main", "index.js");

/** Generated test videos, one folder per version of media.ts. */
export const MEDIA_CACHE_DIR = join(E2E_DIR, "media");

/** Test results: traces, screenshots and logs of failed tests. */
export const RESULTS_DIR = join(E2E_DIR, "results");

/** The bundled ffmpeg (`npm run ffmpeg`), or STREAMY_FFMPEG_DIR. */
export function ffmpegDir(): string {
  return (
    process.env.STREAMY_FFMPEG_DIR ??
    join(APP_DIR, "vendor", "ffmpeg", `${process.platform}-${process.arch}`)
  );
}

export function ffmpegPath(name: "ffmpeg" | "ffprobe"): string {
  return join(ffmpegDir(), process.platform === "win32" ? `${name}.exe` : name);
}

/** The ffmpeg version Streamy ships ("8.1.3"), from scripts/ffmpeg.json. */
export function pinnedFfmpegVersion(): string {
  const pinned = JSON.parse(
    readFileSync(join(APP_DIR, "scripts", "ffmpeg.json"), "utf8"),
  ) as { ffmpegVersion: string };
  return pinned.ffmpegVersion;
}
