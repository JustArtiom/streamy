import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { app } from "electron";
import type { SystemIntegration } from "../shared/settings";
import { isTestMode } from "./test-mode";
import { appImagePath } from "./updates/mode";

// Settings that live in the operating system, not in settings.json: opening
// at login, and being the app that opens magnet: links.
//
// Only the installed app can change them. A dev build would register the
// Electron binary itself (and on macOS it can't register at all). The e2e
// tests never touch them either (test-mode.ts).
//
// The Linux AppImage can open at login (an autostart file that starts the
// .AppImage), but it can't be the magnet app: that needs a streamy.desktop
// file in the system's application list, which only the .deb installs.

const MAGNET = "magnet";
const available = () => app.isPackaged && !isTestMode();

/** The .AppImage file Streamy runs from, or null (.deb, macOS, Windows). */
function runningAppImage(): string | null {
  return process.platform === "linux"
    ? appImagePath(process.env, process.execPath)
    : null;
}

/**
 * What starts this copy of Streamy: the .AppImage file (the executable
 * inside it lives in a temporary mount), or else the executable.
 */
export function launcherPath(): string {
  return runningAppImage() ?? process.execPath;
}

/** Linux has no login-items API: desktops start whatever is in autostart/. */
function linuxAutostartFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const config =
    xdg && isAbsolute(xdg) ? xdg : join(app.getPath("home"), ".config");
  return join(config, "autostart", "streamy.desktop");
}

function linuxAutostartEntry(executable: string): string {
  // Desktop-entry quoting: escape \ " ` $ inside double quotes.
  const quoted = `"${executable.replace(/[\\"`$]/g, (char) => `\\${char}`)}"`;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Streamy",
    `Exec=${quoted}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/**
 * The program an autostart entry written by Streamy starts, or null if the
 * entry isn't in the form Streamy writes (then it's left alone).
 */
export function autostartExecutable(entry: string): string | null {
  const match = /^Exec="((?:[^"\\]|\\.)*)"\s*$/m.exec(entry);
  const quoted = match?.[1];
  return quoted === undefined ? null : quoted.replace(/\\(.)/g, "$1");
}

/**
 * Linux: "Open at login" (if it's on) starts `executable` from now on. For an
 * AppImage that an update renamed.
 */
export function moveLinuxAutostart(executable: string): void {
  if (!available() || process.platform !== "linux") return;
  const file = linuxAutostartFile();
  if (!existsSync(file)) return;
  writeFileSync(file, linuxAutostartEntry(executable));
}

/**
 * Linux, at startup: if "Open at login" starts a file that's gone (an
 * AppImage that was moved, or replaced by an update under another name), it
 * starts this copy instead. An entry for another copy that still exists
 * (the .deb and an AppImage side by side) is left as it is. Returns true if
 * it changed the entry.
 */
export function repairLinuxAutostart(
  exists: (file: string) => boolean = existsSync,
): boolean {
  if (!available() || process.platform !== "linux") return false;
  const file = linuxAutostartFile();
  let entry: string;
  try {
    entry = readFileSync(file, "utf8");
  } catch {
    return false; // Off (no file), or unreadable: nothing to repair.
  }
  const current = launcherPath();
  const starts = autostartExecutable(entry);
  if (starts === null || starts === current || exists(starts)) return false;
  writeFileSync(file, linuxAutostartEntry(current));
  return true;
}

export function getSystemIntegration(): SystemIntegration {
  if (!available()) {
    return {
      available: false,
      openAtLogin: false,
      openAtLoginNeedsApproval: false,
      handlesMagnetLinks: false,
      canHandleMagnetLinks: false,
    };
  }

  let openAtLogin: boolean;
  let openAtLoginNeedsApproval = false;
  if (process.platform === "linux") {
    openAtLogin = existsSync(linuxAutostartFile());
  } else {
    const login = app.getLoginItemSettings();
    openAtLogin = login.openAtLogin;
    openAtLoginNeedsApproval =
      process.platform === "darwin" && login.status === "requires-approval";
  }

  return {
    available: true,
    openAtLogin,
    openAtLoginNeedsApproval,
    // What the system says (from the AppImage too: the .deb may be the one
    // registered).
    handlesMagnetLinks: app.isDefaultProtocolClient(MAGNET),
    canHandleMagnetLinks: runningAppImage() === null,
  };
}

export function setOpenAtLogin(enabled: boolean): SystemIntegration {
  if (available()) {
    if (process.platform === "linux") {
      const file = linuxAutostartFile();
      if (enabled) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, linuxAutostartEntry(launcherPath()));
      } else {
        rmSync(file, { force: true });
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
  }
  return getSystemIntegration();
}

/**
 * Linux can make Streamy the magnet handler but not undo it: the user picks
 * another app in their system settings instead. The AppImage can't do
 * either (it has no streamy.desktop in the system's application list, so
 * the system would send links to an app that doesn't exist).
 */
export function setHandlesMagnetLinks(enabled: boolean): SystemIntegration {
  if (available() && runningAppImage() === null) {
    if (enabled) app.setAsDefaultProtocolClient(MAGNET);
    else if (process.platform !== "linux") {
      app.removeAsDefaultProtocolClient(MAGNET);
    }
  }
  return getSystemIntegration();
}
