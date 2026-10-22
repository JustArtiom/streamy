import { BrowserWindow, type WebContents } from "electron";
import type { AppActions } from "./menu";

/**
 * Windows/Linux keyboard shortcuts. macOS gets these from its menu bar (full
 * screen is ⌃⌘F there); on Windows/Linux the menu isn't shown, so the keys
 * are caught here instead, before the page sees them.
 */
export function handleShortcuts(
  contents: WebContents,
  actions: AppActions,
): void {
  if (process.platform === "darwin") return;

  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const modifiers = input.control || input.alt || input.meta || input.shift;

    // F11: full screen, like in browsers. Holding it down toggles once.
    if (input.key === "F11" && !modifiers) {
      event.preventDefault();
      if (!input.isAutoRepeat) toggleFullScreen(contents);
      return;
    }

    if (!input.control || input.alt || input.meta) return;
    const action = {
      ",": actions.openSettings,
      o: actions.openTorrentFile,
      "=": actions.zoomIn,
      "+": actions.zoomIn,
      "-": actions.zoomOut,
      "0": actions.resetZoom,
    }[input.key];
    if (action) {
      event.preventDefault();
      action();
    }
  });
}

function toggleFullScreen(contents: WebContents): void {
  const window = BrowserWindow.fromWebContents(contents);
  window?.setFullScreen(!window.isFullScreen());
}
