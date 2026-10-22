import { mkdir } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  shell,
} from "electron";
import { z } from "zod";
import { type AppInfo, IpcChannel } from "../shared/api";
import type { ActionResult } from "../shared/settings";
import { logsDir } from "./paths";
import { isAppUrl } from "./protocol";
import { restartApp } from "./relaunch";
import {
  getSystemIntegration,
  setHandlesMagnetLinks,
  setOpenAtLogin,
} from "./system-integration";

/**
 * Like ipcMain.handle, but only our own UI may call it. Arguments arrive as
 * `unknown`: every handler must validate what it gets.
 */
export function handleTrusted(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const url = event.senderFrame?.url;
    if (!url || !isAppUrl(url)) {
      throw new Error("IPC call from an untrusted page");
    }
    return handler(event, ...args);
  });
}

export function registerAppIpc(): void {
  handleTrusted(IpcChannel.GetAppInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
  }));

  // Not with the magnet link or .torrent file Streamy was opened with: those
  // would open again.
  handleTrusted(IpcChannel.Relaunch, () => {
    restartApp();
  });

  // The calling window's OS full screen. Entering or leaving it (this way or
  // any other) sends FullScreenChanged (see window.ts).
  handleTrusted(
    IpcChannel.GetFullScreen,
    (event) =>
      BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false,
  );
  handleTrusted(IpcChannel.SetFullScreen, (event, value) => {
    const fullScreen = z.boolean().parse(value);
    BrowserWindow.fromWebContents(event.sender)?.setFullScreen(fullScreen);
  });

  handleTrusted(IpcChannel.GetSystemIntegration, () => getSystemIntegration());
  handleTrusted(IpcChannel.SetOpenAtLogin, (_event, enabled) =>
    setOpenAtLogin(z.boolean().parse(enabled)),
  );
  handleTrusted(IpcChannel.SetHandlesMagnetLinks, (_event, enabled) =>
    setHandlesMagnetLinks(z.boolean().parse(enabled)),
  );

  // Settings → Advanced → "Open logs folder" (main.log, engine.log).
  handleTrusted(IpcChannel.OpenLogs, async (): Promise<ActionResult> => {
    const dir = logsDir();
    await mkdir(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return error ? { status: "error", message: error } : { status: "ok" };
  });
}
