import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  EngineConfig,
  EngineInitMessage,
} from "../../shared/engine-protocol";
import { initRuntime, resetRuntimeForTests, type Tuning } from "../config";
import { CACHE_MARKER } from "../../shared/video-folder";

/*
 * Test helpers: a configured engine runtime in a temporary folder, and the
 * ffmpeg to use (the bundled one when it's been downloaded).
 */

export const TEST_SECRET = "0123456789abcdef".repeat(4);

/** The ffmpeg/ffprobe tests should run, or null if there's none. */
export function findFfmpeg(): { ffmpeg: string; ffprobe: string } | null {
  const exe = process.platform === "win32" ? ".exe" : "";
  const dirs = [
    process.env.STREAMY_FFMPEG_DIR,
    // The bundled jellyfin-ffmpeg (npm run ffmpeg).
    resolve(
      import.meta.dirname,
      "../../../vendor/ffmpeg",
      `${process.platform}-${process.arch}`,
    ),
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of dirs) {
    const ffmpeg = join(dir, `ffmpeg${exe}`);
    const ffprobe = join(dir, `ffprobe${exe}`);
    if (existsSync(ffmpeg) && existsSync(ffprobe)) return { ffmpeg, ffprobe };
  }
  // Else whatever is on the PATH (e.g. Homebrew's).
  const works = (name: string) =>
    spawnSync(name, ["-version"], { stdio: "ignore" }).status === 0;
  if (works("ffmpeg") && works("ffprobe")) {
    return { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };
  }
  return null;
}

export function testConfig(cacheDir: string): EngineConfig {
  return {
    cacheDir,
    cacheLimitBytes: null,
    hardwareEncoding: "auto",
    downloadLimit: null,
    uploadLimit: null,
    keepSharingMinutes: 10,
    maxConnections: 100,
  };
}

export function testInitMessage(
  base: string,
  overrides: Partial<EngineInitMessage> = {},
): EngineInitMessage {
  const ffmpeg = findFfmpeg();
  return {
    type: "init",
    secret: TEST_SECRET,
    config: testConfig(join(base, "cache")),
    dataDir: join(base, "data"),
    logsDir: join(base, "logs"),
    ffmpegPath: ffmpeg?.ffmpeg ?? "ffmpeg",
    ffprobePath: ffmpeg?.ffprobe ?? "ffprobe",
    logLevel: "info",
    appVersion: "0.0.0-test",
    ...overrides,
  };
}

/** Makes a video folder the way main does: the folder and its marker. */
export async function makeVideoFolder(cacheDir: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, CACHE_MARKER), "test\n");
}

/**
 * Sets up the runtime with a fresh temporary folder (and a video folder in
 * it, made like main makes it). Call `cleanup()` in
 * afterAll/afterEach: it forgets the runtime and deletes the folder.
 */
export async function useTestRuntime(
  tuning: Partial<Tuning> = {},
): Promise<{ base: string; cacheDir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "streamy-engine-test-"));
  const init = testInitMessage(base);
  await makeVideoFolder(init.config.cacheDir);
  initRuntime(init, tuning);
  return {
    base,
    cacheDir: init.config.cacheDir,
    cleanup: async () => {
      resetRuntimeForTests();
      await rm(base, { recursive: true, force: true });
    },
  };
}
