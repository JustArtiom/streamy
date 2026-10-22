import { join } from "node:path";
import { BrowserWindow, nativeTheme, screen } from "electron";
import { IpcChannel, TITLE_BAR_HEIGHT } from "../shared/api";
import { windowIconPath } from "./icon";
import { uiUrl } from "./protocol";
import {
  loadWindowState,
  MIN_WINDOW_SIZE,
  saveWindowState,
} from "./window-state";

const isMac = process.platform === "darwin";

// Must match --background / --foreground in src/renderer/src/index.css.
const COLORS = {
  light: { background: "#ffffff", foreground: "#0a0a0a" },
  dark: { background: "#0a0a0a", foreground: "#ededed" },
};

function themeColors() {
  return nativeTheme.shouldUseDarkColors ? COLORS.dark : COLORS.light;
}

/**
 * Windows/Linux: the native minimize/maximize/close buttons drawn on top of
 * our title bar, in our colors. As tall as the bar at this interface size
 * (`zoom`, the uiScale setting), minus 1px so they don't paint over its
 * bottom border (the line under the title bar stays full width).
 */
export function titleBarOverlay(zoom: number) {
  const colors = themeColors();
  return {
    color: colors.background,
    symbolColor: colors.foreground,
    height: Math.round(TITLE_BAR_HEIGHT * zoom) - 1,
  };
}

/** macOS: where the traffic lights go, centered in our bar at this size. */
export function trafficLightPosition(zoom: number) {
  return { x: 16, y: Math.round((TITLE_BAR_HEIGHT * zoom - 16) / 2) };
}

/**
 * Sets a window's interface size (the uiScale setting): the page's zoom,
 * and the native window buttons to match the title bar's new height.
 */
export function setInterfaceScale(win: BrowserWindow, zoom: number): void {
  win.webContents.setZoomFactor(zoom);
  if (isMac) win.setWindowButtonPosition(trafficLightPosition(zoom));
  else win.setTitleBarOverlay(titleBarOverlay(zoom));
}

/** Work areas of all screens, primary first (for restoring the window). */
function screenWorkAreas() {
  const primary = screen.getPrimaryDisplay();
  return [
    primary,
    ...screen.getAllDisplays().filter((display) => display.id !== primary.id),
  ].map((display) => display.workArea);
}

interface MainWindowOptions {
  /** Where the window's size and position are remembered. */
  stateFile: string;
  /** Interface size to start with (the uiScale setting). */
  zoomFactor: number;
  /**
   * Never shown and muted, but still painting and playing: the smoke test
   * (smoke.ts) and the e2e tests (test-mode.ts).
   */
  hidden?: boolean;
}

export function createMainWindow({
  stateFile,
  zoomFactor,
  hidden = false,
}: MainWindowOptions): BrowserWindow {
  const state = loadWindowState(stateFile, screenWorkAreas());
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: "Streamy",
    icon: windowIconPath(),
    // Shown once the UI has painted, so there's no white flash.
    show: false,
    backgroundColor: themeColors().background,
    // No OS title bar: the UI draws its own (see title-bar.tsx).
    titleBarStyle: "hidden",
    ...(isMac
      ? // macOS: keep the traffic lights, centered in our bar.
        { trafficLightPosition: trafficLightPosition(zoomFactor) }
      : // Windows/Linux: native window buttons on top of our bar.
        { titleBarOverlay: titleBarOverlay(zoomFactor) }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      // These are Electron's defaults; spelled out so nobody turns them off.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      zoomFactor,
      // Timers and video in a hidden window keep running at full speed
      // (the e2e tests watch videos in it).
      ...(hidden && { backgroundThrottling: false }),
    },
    // A hidden window still renders (Electron's default, spelled out).
    ...(hidden && { paintWhenInitiallyHidden: true }),
  });

  if (hidden) {
    win.webContents.setAudioMuted(true);
  } else {
    win.once("ready-to-show", () => {
      if (state.maximized) win.maximize();
      win.show();
    });
  }

  // Remember the size and position shortly after every change (so a crash or
  // force quit doesn't lose it), and once more when the window closes.
  // Normal bounds = the size it returns to when un-maximized. "Maximized" is
  // tracked from events: a minimized window doesn't report it reliably.
  let maximized = state.maximized;
  let saveTimer: NodeJS.Timeout | undefined;
  const saveState = () => {
    clearTimeout(saveTimer);
    if (win.isDestroyed()) return;
    saveWindowState(stateFile, { ...win.getNormalBounds(), maximized });
  };
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  };
  win.on("resize", saveSoon);
  win.on("move", saveSoon);
  win.on("maximize", () => {
    maximized = true;
    saveSoon();
  });
  win.on("unmaximize", () => {
    maximized = false;
    saveSoon();
  });
  win.on("close", saveState);

  // Follow the OS light/dark switch while the app is open.
  const onThemeChange = () => {
    win.setBackgroundColor(themeColors().background);
    if (!isMac) {
      win.setTitleBarOverlay(titleBarOverlay(win.webContents.getZoomFactor()));
    }
  };
  nativeTheme.on("updated", onThemeChange);
  win.on("closed", () => {
    nativeTheme.off("updated", onThemeChange);
  });

  // macOS hides the traffic lights in full screen, so the UI drops their gap.
  const sendFullScreen = (fullScreen: boolean) => {
    win.webContents.send(IpcChannel.FullScreenChanged, fullScreen);
  };
  win.on("enter-full-screen", () => {
    sendFullScreen(true);
  });
  win.on("leave-full-screen", () => {
    sendFullScreen(false);
  });

  void win.loadURL(uiUrl());
  return win;
}
