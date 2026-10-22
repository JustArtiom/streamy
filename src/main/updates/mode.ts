import { dirname, join, posix } from "node:path";

// Which kind of updates this copy of Streamy can have (PLAN §11, Phase 5):
//
//   auto         electron-updater downloads the new version in the background
//                and installs it on restart. The Windows installer (NSIS) and
//                the Linux AppImage.
//   notify       only says that a new version exists and links to it. macOS:
//                an unsigned app can't replace itself (Squirrel.Mac checks the
//                code signature), so people download it themselves. Also an
//                AppImage in a folder Streamy can't write to.
//   unsupported  no checks at all: dev builds, the smoke test, the .deb (apt
//                updates it, not us), a portable or unpacked Windows folder.

export type UpdateMode = "auto" | "notify" | "unsupported";

/**
 * The .AppImage file this copy of Streamy runs from, or null if it isn't
 * running from one. The AppImage runtime sets APPIMAGE (the file) and
 * APPDIR (where it's mounted, which is where Streamy's own executable then
 * is). Apps started from another AppImage inherit both, so APPIMAGE alone
 * would point at someone else's file: the executable must be inside APPDIR.
 */
export function appImagePath(
  env: NodeJS.ProcessEnv,
  execPath: string,
): string | null {
  const { APPIMAGE: file, APPDIR: mount } = env;
  if (!file || !mount || !posix.isAbsolute(file)) return null;
  const inside = mount.endsWith("/") ? mount : `${mount}/`;
  return execPath.startsWith(inside) ? file : null;
}

/** Facts about this run that decide the mode. Injected, so tests can fake them. */
export interface BuildFacts {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** STREAMY_SMOKE=1: CI's packaged smoke test never goes online. */
  smoke: boolean;
  /** The product name ("Streamy"), for the uninstaller's file name. */
  appName: string;
  env: NodeJS.ProcessEnv;
  resourcesPath: string;
  execPath: string;
  exists: (path: string) => boolean;
  /** Whether Streamy may create and delete files in a folder. */
  canWrite: (dir: string) => boolean;
}

export interface ModeDecision {
  mode: UpdateMode;
  /** Why, for main.log. */
  reason: string;
}

export function updateMode(facts: BuildFacts): ModeDecision {
  if (!facts.isPackaged) return unsupported("dev build");
  if (facts.smoke) return unsupported("smoke test");

  // electron-builder writes app-update.yml (where to look for updates) into
  // the resources of every packaged build that has a `publish` setting.
  const hasUpdateConfig = facts.exists(
    join(facts.resourcesPath, "app-update.yml"),
  );

  switch (facts.platform) {
    case "darwin":
      return { mode: "notify", reason: "macOS build isn't signed" };

    case "win32": {
      // electron-builder's portable .exe sets this. It has no installer to run.
      if (facts.env.PORTABLE_EXECUTABLE_DIR) return unsupported("portable");
      if (!hasUpdateConfig) return unsupported("no app-update.yml");
      // The NSIS installer leaves its uninstaller next to Streamy.exe. Without
      // it this is an unpacked folder (e.g. dist/win-unpacked), and an update
      // would install a second copy somewhere else.
      const uninstaller = join(
        dirname(facts.execPath),
        `Uninstall ${facts.appName}.exe`,
      );
      if (!facts.exists(uninstaller)) return unsupported("not installed");
      return { mode: "auto", reason: "Windows installer" };
    }

    case "linux": {
      // Only an AppImage updates itself: its .AppImage file is what gets
      // replaced. The .deb (apt updates it) and unpacked folders don't.
      const appImage = appImagePath(facts.env, facts.execPath);
      if (!appImage) return unsupported("not an AppImage");
      if (!hasUpdateConfig) return unsupported("no app-update.yml");
      // The update replaces the file, so its folder must be ours to write.
      if (!facts.canWrite(dirname(appImage))) {
        return { mode: "notify", reason: "AppImage folder isn't writable" };
      }
      return { mode: "auto", reason: "AppImage" };
    }

    default:
      return unsupported(`platform ${facts.platform}`);
  }
}

function unsupported(reason: string): ModeDecision {
  return { mode: "unsupported", reason };
}
