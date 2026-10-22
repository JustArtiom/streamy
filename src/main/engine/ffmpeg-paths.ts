import { existsSync } from "node:fs";
import path from "node:path";

// Where the engine finds ffmpeg and ffprobe (PLAN §6):
// - STREAMY_FFMPEG_DIR (a folder with both) wins, for testing other builds,
//   but only in dev and the e2e tests: the installed app never runs programs
//   an environment variable points it to;
// - the installed app: the copies bundled in its resources folder;
// - `npm run dev`: the ones `npm run ffmpeg` downloaded into vendor/, or
//   else whatever is on the PATH (with a warning in main.log).
// If they don't work, the engine says so in /v1/health.

export interface FfmpegPaths {
  ffmpegPath: string;
  ffprobePath: string;
  /** Where they came from (for the log). "system" = looked up on the PATH. */
  source: "env" | "bundled" | "vendor" | "system";
}

interface FfmpegPathOptions {
  isPackaged: boolean;
  /** process.resourcesPath */
  resourcesPath: string;
  /** The app's root folder (the project folder in dev). */
  appPath: string;
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  exists?: (file: string) => boolean;
}

export function findFfmpeg({
  isPackaged,
  resourcesPath,
  appPath,
  platform,
  arch,
  env,
  exists = existsSync,
}: FfmpegPathOptions): FfmpegPaths {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const exe = (name: string) => (platform === "win32" ? `${name}.exe` : name);
  const inFolder = (dir: string, source: FfmpegPaths["source"]) => ({
    ffmpegPath: paths.join(dir, exe("ffmpeg")),
    ffprobePath: paths.join(dir, exe("ffprobe")),
    source,
  });

  if (isPackaged) {
    return inFolder(paths.join(resourcesPath, "ffmpeg"), "bundled");
  }
  const override = env.STREAMY_FFMPEG_DIR?.trim();
  if (override) return inFolder(paths.resolve(override), "env");

  const vendor = inFolder(
    paths.join(appPath, "vendor", "ffmpeg", `${platform}-${arch}`),
    "vendor",
  );
  if (exists(vendor.ffmpegPath) && exists(vendor.ffprobePath)) return vendor;
  // The engine spawns them without a shell, so the OS searches the PATH.
  return {
    ffmpegPath: exe("ffmpeg"),
    ffprobePath: exe("ffprobe"),
    source: "system",
  };
}
