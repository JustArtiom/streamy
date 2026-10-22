import { accessSync, constants, existsSync } from "node:fs";
import { app, net, shell } from "electron";
import electronUpdater from "electron-updater";
import { IpcChannel } from "../../shared/api";
import { handleTrusted } from "../ipc";
import type { Logger } from "../logs";
import type { SettingsStore } from "../settings/store";
import { moveLinuxAutostart } from "../system-integration";
import { sendToAllWindows } from "../ui-messages";
import { type UpdateMode, updateMode } from "./mode";
import { type UpdateBackend, Updater } from "./updater";

// Connects the updater (updater.ts) to Electron: which mode this build gets,
// electron-updater, the IPC the UI uses, and the status in every window.
//
// electron-updater is imported here (not loaded on demand) so that the
// packaged smoke test in CI proves it loads on every OS.

interface UpdatesOptions {
  log: Logger;
  /** STREAMY_SMOKE=1: never goes online. */
  smoke: boolean;
  /** The checkForUpdates setting turns the automatic checks on and off. */
  settings: Pick<SettingsStore, "get" | "onChange">;
  /** Stops the playback engine before "Restart to update" quits. */
  beforeInstall: () => Promise<void>;
}

/** True if Streamy may create and delete files in `dir`. */
function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run once the app is ready. */
export function setupUpdates({
  log,
  smoke,
  settings,
  beforeInstall,
}: UpdatesOptions): Updater {
  const { mode, reason } = updateMode({
    platform: process.platform,
    isPackaged: app.isPackaged,
    smoke,
    appName: app.getName(),
    env: process.env,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    exists: existsSync,
    canWrite,
  });
  log.info({ mode, reason }, "Updates");

  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });

  const updater = new Updater({
    mode,
    automaticChecks: settings.get().checkForUpdates,
    currentVersion: app.getVersion(),
    log,
    createBackend: () => createBackend(mode, log),
    fetch: (url, init) => net.fetch(url, init),
    openExternal: (url) => shell.openExternal(url),
    beforeInstall,
    isQuitting: () => quitting,
    quit: () => {
      app.quit();
    },
  });

  updater.onStatusChange((status) => {
    sendToAllWindows(IpcChannel.UpdateStatusChanged, status);
  });
  handleTrusted(IpcChannel.GetUpdateStatus, () => updater.status());
  handleTrusted(IpcChannel.CheckForUpdates, () => updater.check());
  handleTrusted(IpcChannel.InstallUpdate, () => updater.install());
  handleTrusted(IpcChannel.OpenReleasePage, () => updater.openReleasePage());

  const stopFollowing = settings.onChange((next) => {
    updater.setAutomaticChecks(next.checkForUpdates);
  });
  app.once("will-quit", () => {
    stopFollowing();
    updater.dispose();
  });
  updater.start();
  return updater;
}

/** electron-updater's autoUpdater, set up for Streamy ("auto" mode only). */
function createBackend(mode: UpdateMode, log: Logger): UpdateBackend {
  if (mode !== "auto") throw new Error(`No electron-updater in ${mode} mode`);
  // The property creates the right updater for this OS on first use.
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = {
    info: (message?: unknown) => {
      log.info({ from: "electron-updater" }, String(message));
    },
    warn: (message?: unknown) => {
      log.warn({ from: "electron-updater" }, String(message));
    },
    error: (message?: unknown) => {
      log.error({ from: "electron-updater" }, String(message));
    },
  };
  autoUpdater.autoDownload = true;
  // A downloaded update also installs when Streamy quits normally.
  autoUpdater.autoInstallOnAppQuit = true;
  // We publish full installers only (no nsis-web).
  autoUpdater.disableWebInstaller = true;
  // electron-updater emits "error" as well as rejecting its promises (which
  // updater.ts handles). An EventEmitter "error" without a listener throws.
  autoUpdater.on("error", (error) => {
    log.debug({ err: error }, "electron-updater error event");
  });
  // An AppImage whose name has a version in it gets the new version's name
  // (our releases name it without one, but a renamed download may have
  // one). "Open at login" must start the new file.
  autoUpdater.on("appimage-filename-updated", (file) => {
    log.info("The AppImage was renamed by the update");
    try {
      moveLinuxAutostart(file);
    } catch (error) {
      log.warn({ err: error }, "Could not update the autostart entry");
    }
  });
  return {
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: (isSilent, isForceRunAfter) => {
      // The new version may start while this one is still quitting (the
      // AppImage does). Holding the single-instance lock, this one would
      // make it quit right away; it's done with the lock anyway.
      app.releaseSingleInstanceLock();
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
    },
    on: (event, listener) => autoUpdater.on(event, listener),
  };
}
