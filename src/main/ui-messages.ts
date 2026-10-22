import { BrowserWindow, type WebContents } from "electron";

/**
 * Sends a message to a window's UI. A page that's still loading hasn't
 * subscribed yet, so the message waits until it has loaded.
 */
export function sendWhenLoaded(
  contents: WebContents,
  channel: string,
  ...args: unknown[]
): void {
  const send = () => {
    contents.send(channel, ...args);
  };
  if (contents.isLoading()) contents.once("did-finish-load", send);
  else send();
}

/** Sends a message to every open window's UI (e.g. a status change). */
export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, ...args);
  }
}
