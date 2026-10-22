import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegPath } from "./paths";

// One throwaway folder per test. Launches of Streamy in the same test share
// it, so a relaunch sees the same settings, library and videos.
//
//   <workspace>/profile    --user-data-dir: settings.json, library.db,
//                          logs/, "Video Cache"/ (the default video folder)
//   <workspace>/bin        ffmpeg and ffprobe (links to the bundled ones):
//                          Streamy runs them from here, so they're easy to
//                          tell apart from every other ffmpeg on the machine

export type Workspace = {
  root: string;
  profile: string;
  bin: string;
  logs: string;
  settingsFile: string;
  /** Where the engine keeps downloaded torrents (the default video folder). */
  torrentsDir: string;
};

/**
 * All workspaces of one `npm run e2e` share this prefix, so global-teardown
 * can find anything a crashed worker left behind.
 */
export function workspacePrefix(): string {
  const run = process.env.E2E_RUN_ID ?? String(process.pid);
  return `streamy-e2e-${run}-`;
}

/** E2E_TMP_DIR, or the OS temp folder. */
export function tempBase(): string {
  return realpathSync(process.env.E2E_TMP_DIR ?? tmpdir());
}

export async function createWorkspace(): Promise<Workspace> {
  const base = tempBase();
  mkdirSync(base, { recursive: true });
  // realpath: the processes' command lines show the resolved path
  // (macOS's temp folder is behind a symlink).
  const root = realpathSync(mkdtempSync(join(base, workspacePrefix())));
  const profile = join(root, "profile");
  const bin = join(root, "bin");
  mkdirSync(profile);
  mkdirSync(bin);
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    const target = ffmpegPath(name);
    const link = join(bin, target.slice(target.lastIndexOf(name)));
    try {
      symlinkSync(target, link);
    } catch {
      // No symlinks allowed (Windows without developer mode): a copy works too.
      await copyFile(target, link);
    }
  }
  return {
    root,
    profile,
    bin,
    logs: join(profile, "logs"),
    settingsFile: join(profile, "settings.json"),
    torrentsDir: join(profile, "Video Cache", "torrents"),
  };
}

export async function removeWorkspace(workspace: Workspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true, maxRetries: 3 });
}
