import { app, BrowserWindow } from "electron";
import { IpcChannel } from "../../shared/api";
import type { LogLevel } from "../../shared/engine-protocol";
import { handleTrusted } from "../ipc";
import type { Logger } from "../logs";
import { logsDir } from "../paths";
import { devServerOrigin } from "../protocol";
import type { SettingsStore } from "../settings/store";
import { type CacheEngine, createCacheEngine } from "./client";
import { engineConfigSource } from "./config";
import { findFfmpeg } from "./ffmpeg-paths";
import { EngineHost } from "./host";
import { type ApiProxy, createApiProxy, type IdleOptions } from "./proxy";

const LOG_LEVELS: readonly LogLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

/** "info" when installed, "debug" in dev; STREAMY_LOG_LEVEL overrides it. */
function engineLogLevel(): LogLevel {
  const fromEnv = LOG_LEVELS.find(
    (level) => level === process.env.STREAMY_LOG_LEVEL,
  );
  return fromEnv ?? (app.isPackaged ? "info" : "debug");
}

interface EngineOptions {
  /** The engine's built entry file (ENGINE_ENTRY from ./entry). */
  entryPath: string;
  store: SettingsStore;
  defaultCacheDir: string;
  log: Logger;
}

export interface Engine {
  host: EngineHost;
  /** Answers app://streamy/api/* (see protocol.ts). */
  proxy: ApiProxy;
  /** For Settings → Storage. */
  cache: CacheEngine;
}

/**
 * Starts the playback engine and connects it to the rest of the app: its
 * settings, its status in every window, and quitting. Run once the app is
 * ready.
 */
export function setupEngine({
  entryPath,
  store,
  defaultCacheDir,
  log,
}: EngineOptions): Engine {
  const ffmpeg = findFfmpeg({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    arch: process.arch,
    env: process.env,
  });
  if (ffmpeg.source === "system") {
    log.warn(
      "No ffmpeg in vendor/ffmpeg (run `npm run ffmpeg`): using the one on the PATH, if any",
    );
  } else {
    log.info(
      { source: ffmpeg.source, path: ffmpeg.ffmpegPath },
      "Using ffmpeg",
    );
  }

  const config = engineConfigSource({ store, defaultCacheDir, log });
  const host = new EngineHost({
    entryPath,
    log,
    init: () => ({
      config: config.current(),
      dataDir: app.getPath("userData"),
      logsDir: logsDir(),
      ffmpegPath: ffmpeg.ffmpegPath,
      ffprobePath: ffmpeg.ffprobePath,
      logLevel: engineLogLevel(),
      appVersion: app.getVersion(),
    }),
  });
  config.onChange((next) => {
    host.configure(next);
  });

  // For the "Reconnecting…" banner and Settings → Advanced.
  handleTrusted(IpcChannel.GetEngineStatus, () => host.status());
  host.onStatusChange((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IpcChannel.EngineStatusChanged, status);
    }
  });

  const proxy = createApiProxy({
    engine: () => host.connection(),
    devOrigin: devServerOrigin(),
  });
  stopOnQuit(host, proxy);
  host.start();

  return { host, proxy, cache: createCacheEngine(host, log) };
}

/**
 * At quit, how long the windows' last requests get to reach the engine: a
 * closing player saves where you stopped (pagehide, keepalive). Those leave
 * as the window closes and land here a moment later.
 */
export const QUIT_DRAIN: IdleOptions = { quietMs: 250, maxMs: 1_500 };

/**
 * Quitting waits (once) for the engine to shut down cleanly: it stops
 * ffmpeg and saves its library. host.stop() never takes more than a few
 * seconds. If the engine was stopped already ("Restart to update" does that
 * before the installer runs), quitting doesn't wait at all.
 *
 * This happens in "will-quit", not "before-quit": by then every window has
 * closed (Quit menu, ⌘Q, the Dock, the last window on Windows/Linux, an
 * update's quitAndInstall all go through it), so a closing player's last
 * save is already on its way, and the engine stops only after it got there.
 * A quit can't be called off after "will-quit" either, so the engine is
 * never stopped under a window that stays open.
 */
export function stopOnQuit(
  host: Pick<EngineHost, "hasProcess" | "stop">,
  proxy: Pick<ApiProxy, "close" | "whenIdle">,
): void {
  let state: "running" | "stopping" | "stopped" = "running";
  app.on("will-quit", (event) => {
    if (state === "stopped") return;
    if (state === "running" && !host.hasProcess) {
      // Nothing to wait for (e.g. between restarts), but no restart either.
      state = "stopped";
      void host.stop();
      proxy.close();
      return;
    }
    event.preventDefault();
    if (state === "stopping") return;
    state = "stopping";
    void proxy
      .whenIdle(QUIT_DRAIN)
      .then(() => host.stop())
      .finally(() => {
        state = "stopped";
        proxy.close();
        app.quit();
      });
  });

  // Windows: signing out or shutting down ends Streamy without "will-quit"
  // (the OS gives it a few seconds). Ask the engine to save and stop anyway.
  app.on("browser-window-created", (_event, window) => {
    window.on("session-end", () => {
      void host.stop();
    });
  });
}
