import { join } from "node:path";
import { app } from "electron";

// Packaged macOS and Windows apps show the icon from the app bundle / .exe by
// themselves. These cover the rest:
// - Linux: the window needs its icon set explicitly.
// - `npm run dev`: show our icon instead of Electron's.
// The icon files come from `npm run icons` (scripts/icons.mjs).

const devIcon = (file: string) => join(app.getAppPath(), "build", file);

/** Icon for BrowserWindow, or undefined where the OS already has it. */
export function windowIconPath(): string | undefined {
  if (process.platform === "darwin") return undefined;
  if (app.isPackaged) {
    // Copied there by electron-builder (linux.extraResources).
    return process.platform === "linux"
      ? join(process.resourcesPath, "icon.png")
      : undefined;
  }
  return devIcon(
    process.platform === "win32" ? "icon.ico" : "icons/512x512.png",
  );
}

/** macOS while developing: our icon in the Dock instead of Electron's. */
export function setDevDockIcon(): void {
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(devIcon("icon.png"));
  }
}
