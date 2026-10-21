import type { WebContents } from "electron";
import type { AppActions } from "./menu";

/**
 * Windows/Linux keyboard shortcuts. macOS gets these from its menu bar; on
 * Windows/Linux the menu isn't shown, so the keys are caught here instead,
 * before the page sees them.
 */
export function handleShortcuts(
  contents: WebContents,
  actions: AppActions,
): void {
  if (process.platform === "darwin") return;

  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt || input.meta) {
      return;
    }
    const action = {
      ",": actions.openSettings,
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
