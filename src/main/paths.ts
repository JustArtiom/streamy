import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import { defaultCacheDir } from "./settings/cache-dir";

/**
 * Name of our folders on disk. Dev builds get their own, so `npm run dev`
 * never touches the settings or videos of the installed app.
 */
const folderName = app.isPackaged ? app.getName() : `${app.getName()} Dev`;

/** Set by `--user-data-dir=<path>` (e.g. a clean profile for testing). */
let customUserData: string | undefined;

/**
 * Picks the folder for settings and other app data. Must run before anything
 * uses it (the single-instance lock, sessions…), so first thing at startup.
 */
export function configureDataPaths(): void {
  const custom = app.commandLine.getSwitchValue("user-data-dir");
  customUserData = custom ? resolve(custom) : undefined;
  const userData = customUserData ?? join(app.getPath("appData"), folderName);
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

/** A file in the app's data folder (e.g. settings.json). */
export function dataFile(name: string): string {
  return join(app.getPath("userData"), name);
}

export function getDefaultCacheDir(): string {
  // A custom profile keeps its videos to itself too.
  if (customUserData) return join(customUserData, "Video Cache");
  return defaultCacheDir({
    platform: process.platform,
    home: app.getPath("home"),
    env: process.env,
    name: folderName,
  });
}

/** The user's own folders: Streamy never takes one over as its video folder. */
export function getProtectedDirs(): string[] {
  const names = [
    "home",
    "desktop",
    "documents",
    "downloads",
    "music",
    "pictures",
    "videos",
    "appData",
  ] as const;
  return names.flatMap((name) => {
    try {
      return [app.getPath(name)];
    } catch {
      return []; // Not every OS has every folder.
    }
  });
}
