import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildApp } from "./support/build";
import { ensureMedia } from "./support/media";
import { ffmpegPath } from "./support/paths";
import { killHard, processesMentioning } from "./support/processes";
import { tempBase, workspacePrefix } from "./support/workspace";

// Runs once before all tests: builds the app and makes the test videos.
// Returns the global teardown: a last sweep for anything a crashed worker
// may have left (each test cleans up after itself; this should find nothing).

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.platform === "win32") {
    // The process checks use ps and lsof (support/processes.ts).
    throw new Error("The e2e tests run on macOS and Linux.");
  }
  if (!existsSync(ffmpegPath("ffmpeg")) || !existsSync(ffmpegPath("ffprobe"))) {
    throw new Error(
      `No bundled ffmpeg at ${ffmpegPath("ffmpeg")}: run \`npm run ffmpeg\` first (or set STREAMY_FFMPEG_DIR).`,
    );
  }
  // Names this run's workspaces (workers inherit it).
  process.env.E2E_RUN_ID ??= `${Date.now().toString(36)}${process.pid}`;

  let started = Date.now();
  const { built } = await buildApp();
  console.log(
    built
      ? `e2e: built the app in ${Date.now() - started} ms`
      : "e2e: E2E_SKIP_BUILD is set: using the existing build",
  );

  started = Date.now();
  const media = await ensureMedia();
  console.log(
    media.generated
      ? `e2e: made the test videos in ${Date.now() - started} ms`
      : "e2e: using the cached test videos",
  );

  return async () => {
    const prefix = workspacePrefix();
    const leftovers = await processesMentioning(prefix);
    for (const { pid } of leftovers) killHard(pid);
    if (leftovers.length > 0) {
      console.warn(
        `e2e: killed ${leftovers.length} process(es) left by a crashed test`,
      );
    }
    const base = tempBase();
    for (const name of readdirSync(base)) {
      if (name.startsWith(prefix)) {
        await rm(join(base, name), { recursive: true, force: true });
      }
    }
  };
}
