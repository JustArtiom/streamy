import { app, BrowserWindow } from "electron";
import { IpcChannel } from "../shared/api";
import { ENGINE_ENTRY } from "./engine/entry";
import { type Engine, setupEngine } from "./engine/index";
import { setDevDockIcon } from "./icon";
import { registerAppIpc } from "./ipc";
import { createMainLogger } from "./logs";
import { receiveMagnetLinks } from "./magnet-links";
import { type AppActions, setAppMenu } from "./menu";
import {
  configureDataPaths,
  dataFile,
  getDefaultCacheDir,
  getProtectedDirs,
  hasCustomUserData,
  logsDir,
} from "./paths";
import { setupPlayerPower } from "./player-power";
import { handleAppProtocol, registerAppScheme } from "./protocol";
import { relaunchOptions } from "./relaunch";
import { hardenWebContents, restrictPermissions } from "./security";
import { setupSettings } from "./settings";
import { SettingsStore } from "./settings/store";
import { handleShortcuts } from "./shortcuts";
import { failSmokeTest, isSmokeTest, runSmokeTest } from "./smoke";
import { repairLinuxAutostart } from "./system-integration";
import { isTestMode } from "./test-mode";
import { receiveTorrentFiles } from "./torrent-files";
import { sendWhenLoaded } from "./ui-messages";
import { setupUpdates } from "./updates";
import { createMainWindow } from "./window";

// Things that must happen before the app is ready. The data folder comes
// first: everything below (settings, the single-instance lock) uses it.
configureDataPaths();
registerAppScheme();
hardenWebContents();

/** STREAMY_SMOKE=1: the CI check in smoke.ts (no visible window). */
const smoke = isSmokeTest();
/** STREAMY_TEST_MODE=1: the e2e tests (see test-mode.ts). */
const testMode = isTestMode();
/** Nothing on screen, no sound, no Dock icon: the smoke test and the e2e tests. */
const headless = smoke || testMode;

if (smoke && !hasCustomUserData()) {
  // A test must never touch someone's real settings, videos or logs.
  failSmokeTest("Run the smoke test with --user-data-dir=<a throwaway folder>");
} else if (testMode && !hasCustomUserData()) {
  process.stderr.write(
    "Streamy: STREAMY_TEST_MODE needs --user-data-dir=<a throwaway folder>\n",
  );
  app.exit(1);
} else {
  const settings = new SettingsStore(dataFile("settings.json"));
  // Only possible before "ready", which is why this setting needs a restart.
  if (!settings.get().hardwareAcceleration) app.disableHardwareAcceleration();

  // One Streamy at a time: opening it again focuses the window that's open.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    startApp(settings);
  }
}

function startApp(settings: SettingsStore): void {
  // The smoke test and the e2e tests show nothing at all, not even a Dock icon.
  if (headless) app.dock?.hide();
  const log = createMainLogger(logsDir(), app.isPackaged ? "info" : "debug");
  log.info(
    {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    },
    "Streamy is starting",
  );

  let mainWindow: BrowserWindow | null = null;
  /** Set once the app is ready (the window is never created before that). */
  let actions: AppActions | null = null;
  /** Set once the app is ready. */
  let engine: Engine | null = null;
  /** Quitting has begun: no new windows from here on. */
  let quitting = false;
  /** "Restart to update": the installer starts the new version itself. */
  let installingUpdate = false;
  /** A launch during the quit asked to start again afterwards. */
  let relaunchQueued = false;
  app.on("before-quit", () => {
    quitting = true;
  });

  const showMainWindow = (): BrowserWindow => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow({
        stateFile: dataFile("window-state.json"),
        zoomFactor: settings.get().uiScale,
        hidden: headless,
      });
      if (actions) handleShortcuts(mainWindow.webContents, actions);
      return mainWindow;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!headless) mainWindow.focus();
    return mainWindow;
  };

  // Registered now: a link or file that launches the app on macOS arrives
  // early.
  const magnetLinks = receiveMagnetLinks({
    showWindow: () => showMainWindow().webContents,
  });
  const torrentFiles = receiveTorrentFiles({
    showWindow: () => showMainWindow().webContents,
    // Files are only handled after start(), when the engine exists.
    engine: {
      whenRunning: (timeoutMs) =>
        engine
          ? engine.host.whenRunning(timeoutMs)
          : Promise.reject(new Error("The playback engine hasn't started.")),
    },
    log,
  });

  app.on("second-instance", (_event, argv, workingDirectory) => {
    if (quitting) {
      // Opened again while this one quits (its windows may be gone, the
      // engine stopping): start again once it's gone, with that launch's
      // link or file. Not during an update: the new version starts anyway.
      if (installingUpdate || relaunchQueued) return;
      relaunchQueued = true;
      log.info("Opened while quitting: Streamy starts again afterwards");
      app.relaunch(
        relaunchOptions(argv.slice(1), {
          keepOpened: true,
          cwd: workingDirectory,
        }),
      );
      return;
    }
    magnetLinks.fromArgv(argv);
    torrentFiles.fromArgv(argv, workingDirectory);
    if (app.isReady()) showMainWindow();
  });

  void app.whenReady().then(() => {
    // Windows uses this id to group the taskbar icon and notifications.
    if (process.platform === "win32") {
      app.setAppUserModelId("io.github.justartiom.streamy");
    }
    const defaultCacheDir = getDefaultCacheDir();
    // First: the UI asks it for data as soon as it loads.
    engine = setupEngine({
      entryPath: ENGINE_ENTRY,
      store: settings,
      defaultCacheDir,
      log,
    });
    handleAppProtocol({ api: engine.proxy.handle });
    restrictPermissions();
    registerAppIpc();
    setupPlayerPower();
    // "Restart to update" stops the engine first, so quitting doesn't have
    // to wait for it while the installer is already running.
    const { host } = engine;
    // Tests never check for updates (they must not go online).
    setupUpdates({
      log,
      smoke: headless,
      settings,
      beforeInstall: () => {
        installingUpdate = true;
        return host.stop();
      },
    });
    // Linux: "Open at login" may start an AppImage that was moved or
    // replaced by an update since.
    try {
      if (repairLinuxAutostart())
        log.info("Pointed Open at login at this copy");
    } catch (error) {
      log.warn({ err: error }, "Could not check the autostart entry");
    }
    // Before the window: it sets the theme the window opens with.
    const controller = setupSettings({
      store: settings,
      defaultCacheDir,
      protectedDirs: getProtectedDirs(),
      dataDir: app.getPath("userData"),
      engine: engine.cache,
    });
    actions = {
      openSettings: () => {
        sendWhenLoaded(showMainWindow().webContents, IpcChannel.OpenSettings);
      },
      openTorrentFile: () => {
        const window = mainWindow?.isDestroyed() === false ? mainWindow : null;
        torrentFiles.chooseAndOpen(window).catch((error: unknown) => {
          log.error({ err: error }, "The Open Torrent File dialog failed");
        });
      },
      zoomIn: () => {
        controller.stepUiScale(1);
      },
      zoomOut: () => {
        controller.stepUiScale(-1);
      },
      resetZoom: controller.resetUiScale,
    };
    setAppMenu(actions);
    if (!headless) setDevDockIcon();
    const window = showMainWindow();
    magnetLinks.start();
    torrentFiles.start();
    if (smoke) runSmokeTest({ host: engine.host, window, log });

    // macOS: clicking the Dock icon with no windows open opens one again
    // (not while quitting: the windows were just closed on purpose).
    app.on("activate", () => {
      if (quitting) return;
      if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
    });
  });

  // macOS apps keep running after their last window closes; others quit.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
