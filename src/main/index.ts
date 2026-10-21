import { app, BrowserWindow } from "electron";
import { IpcChannel } from "../shared/api";
import { setDevDockIcon } from "./icon";
import { registerAppIpc } from "./ipc";
import { receiveMagnetLinks } from "./magnet-links";
import { type AppActions, setAppMenu } from "./menu";
import {
  configureDataPaths,
  dataFile,
  getDefaultCacheDir,
  getProtectedDirs,
} from "./paths";
import { handleAppProtocol, registerAppScheme } from "./protocol";
import { hardenWebContents, restrictPermissions } from "./security";
import { setupSettings } from "./settings";
import { SettingsStore } from "./settings/store";
import { handleShortcuts } from "./shortcuts";
import { createMainWindow } from "./window";

// Things that must happen before the app is ready. The data folder comes
// first: everything below (settings, the single-instance lock) uses it.
configureDataPaths();
registerAppScheme();
hardenWebContents();

const settings = new SettingsStore(dataFile("settings.json"));
// Only possible before "ready", which is why this setting needs a restart.
if (!settings.get().hardwareAcceleration) app.disableHardwareAcceleration();

// One Streamy at a time: opening it again focuses the window that's open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  /** Set once the app is ready (the window is never created before that). */
  let actions: AppActions | null = null;

  const showMainWindow = (): BrowserWindow => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow({
        stateFile: dataFile("window-state.json"),
        zoomFactor: settings.get().uiScale,
      });
      if (actions) handleShortcuts(mainWindow.webContents, actions);
      return mainWindow;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return mainWindow;
  };

  /** Sends a message to the UI, once it has loaded. */
  const sendToMainWindow = (channel: string) => {
    const { webContents } = showMainWindow();
    const send = () => {
      webContents.send(channel);
    };
    if (webContents.isLoading()) webContents.once("did-finish-load", send);
    else send();
  };

  // Registered now: a link that launches the app on macOS arrives early.
  const magnetLinks = receiveMagnetLinks({
    showWindow: () => showMainWindow().webContents,
  });

  app.on("second-instance", (_event, argv) => {
    magnetLinks.fromArgv(argv);
    if (app.isReady()) showMainWindow();
  });

  void app.whenReady().then(() => {
    // Windows uses this id to group the taskbar icon and notifications.
    if (process.platform === "win32") {
      app.setAppUserModelId("io.github.justartiom.streamy");
    }
    handleAppProtocol();
    restrictPermissions();
    registerAppIpc();
    // Before the window: it sets the theme the window opens with.
    const controller = setupSettings({
      store: settings,
      defaultCacheDir: getDefaultCacheDir(),
      protectedDirs: getProtectedDirs(),
      dataDir: app.getPath("userData"),
    });
    actions = {
      openSettings: () => {
        sendToMainWindow(IpcChannel.OpenSettings);
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
    setDevDockIcon();
    showMainWindow();
    magnetLinks.start();

    // macOS: clicking the Dock icon with no windows open opens one again.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
    });
  });

  // macOS apps keep running after their last window closes; others quit.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
