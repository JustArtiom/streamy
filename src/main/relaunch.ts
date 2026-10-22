import { app, type RelaunchOptions } from "electron";
import { isMagnetLink } from "./magnet-links";
import { torrentFileArgument } from "./torrent-files";
import { appImagePath } from "./updates/mode";

// Starting Streamy again once this copy has quit (app.relaunch):
// - Settings' "Restart" (e.g. after turning off hardware acceleration);
// - Streamy opened again while it was still quitting (see index.ts).

interface RelaunchArgsOptions {
  /**
   * Keep the magnet links and .torrent files among the arguments (they
   * belong to a launch that hasn't been handled yet). Otherwise they're
   * dropped: they were opened already, and mustn't open a second time.
   */
  keepOpened: boolean;
  /** The folder relative .torrent paths are relative to. */
  cwd: string;
}

/**
 * What app.relaunch() needs to start this Streamy again with `args` (the
 * arguments after the executable). Switches like --user-data-dir stay, and
 * so does the app's folder in dev (`electron .`).
 */
export function relaunchOptions(
  args: readonly string[],
  { keepOpened, cwd }: RelaunchArgsOptions,
): RelaunchOptions {
  const kept = args.flatMap((arg) => {
    if (isMagnetLink(arg)) return keepOpened ? [arg] : [];
    const file = torrentFileArgument(arg, { cwd });
    if (file === null) return [arg];
    // Absolute: the new copy may start in another folder.
    return keepOpened ? [file] : [];
  });
  // An AppImage's executable is in a temporary mount that's gone once this
  // copy exits: start the .AppImage file itself.
  const appImage =
    process.platform === "linux"
      ? appImagePath(process.env, process.execPath)
      : null;
  return { args: kept, ...(appImage !== null && { execPath: appImage }) };
}

/** Settings → "Restart": quits, then starts again as a plain launch. */
export function restartApp(): void {
  app.relaunch(
    relaunchOptions(process.argv.slice(1), {
      keepOpened: false,
      cwd: process.cwd(),
    }),
  );
  app.quit();
}
