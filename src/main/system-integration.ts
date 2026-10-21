import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { app } from "electron";
import type { SystemIntegration } from "../shared/settings";

// Settings that live in the operating system, not in settings.json: opening
// at login, and being the app that opens magnet: links.
//
// Only the installed app can change them. A dev build would register the
// Electron binary itself (and on macOS it can't register at all).

const MAGNET = "magnet";
const available = () => app.isPackaged;

/** Linux has no login-items API: desktops start whatever is in autostart/. */
function linuxAutostartFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const config =
    xdg && isAbsolute(xdg) ? xdg : join(app.getPath("home"), ".config");
  return join(config, "autostart", "streamy.desktop");
}

function linuxAutostartEntry(): string {
  // An AppImage runs from a temporary mount; APPIMAGE is the real file.
  const executable = process.env.APPIMAGE ?? process.execPath;
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

export function getSystemIntegration(): SystemIntegration {
  if (!available()) {
    return {
      available: false,
      openAtLogin: false,
      openAtLoginNeedsApproval: false,
      handlesMagnetLinks: false,
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
    handlesMagnetLinks: app.isDefaultProtocolClient(MAGNET),
  };
}

export function setOpenAtLogin(enabled: boolean): SystemIntegration {
  if (available()) {
    if (process.platform === "linux") {
      const file = linuxAutostartFile();
      if (enabled) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, linuxAutostartEntry());
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
 * another app in their system settings instead.
 */
export function setHandlesMagnetLinks(enabled: boolean): SystemIntegration {
  if (available()) {
    if (enabled) app.setAsDefaultProtocolClient(MAGNET);
    else if (process.platform !== "linux") {
      app.removeAsDefaultProtocolClient(MAGNET);
    }
  }
  return getSystemIntegration();
}
