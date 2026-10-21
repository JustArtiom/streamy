import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { type AppInfo, IpcChannel } from "../shared/api";
import { isAppUrl } from "./protocol";
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

  handleTrusted(IpcChannel.Relaunch, () => {
    app.relaunch();
    app.quit();
  });

  handleTrusted(IpcChannel.GetSystemIntegration, () => getSystemIntegration());
  handleTrusted(IpcChannel.SetOpenAtLogin, (_event, enabled) =>
    setOpenAtLogin(z.boolean().parse(enabled)),
  );
  handleTrusted(IpcChannel.SetHandlesMagnetLinks, (_event, enabled) =>
    setHandlesMagnetLinks(z.boolean().parse(enabled)),
  );
}
