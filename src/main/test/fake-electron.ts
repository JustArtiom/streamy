import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { FakeUtilityProcess } from "./fake-utility-process";

// A small stand-in for the parts of Electron the main-process code uses, so
// it can be tested in plain Node. Use it with:
//   vi.mock("electron", async () => (await import("../test/fake-electron")).electron);

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** IPC handlers registered with ipcMain.handle, by channel. */
export const ipcHandlers = new Map<string, Handler>();

let nextWebContentsId = 1;

/** Just enough of WebContents for our code. */
export function createFakeWebContents() {
  return Object.assign(new EventEmitter(), {
    id: nextWebContentsId++,
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
    setZoomFactor: vi.fn<(factor: number) => void>(),
    isLoading: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
  });
}

/** A window with just enough of BrowserWindow / WebContents for our code. */
export function createFakeWindow() {
  return {
    webContents: createFakeWebContents(),
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
  };
}

const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  getName: () => "Streamy",
  getVersion: () => "0.0.0-test",
  getPath: vi.fn((name: string) => `/fake/${name}`),
  getAppPath: vi.fn(() => "/fake/app"),
  setAppLogsPath: vi.fn(),
  isReady: vi.fn(() => true),
  isHardwareAccelerationEnabled: vi.fn(() => true),
  relaunch: vi.fn(),
  quit: vi.fn(),
  releaseSingleInstanceLock: vi.fn(),
  getLoginItemSettings: vi.fn(() => ({
    openAtLogin: false,
    status: "not-registered",
  })),
  setLoginItemSettings: vi.fn(),
  isDefaultProtocolClient: vi.fn(() => false),
  setAsDefaultProtocolClient: vi.fn(() => true),
  removeAsDefaultProtocolClient: vi.fn(() => true),
});

export const windows: ReturnType<typeof createFakeWindow>[] = [];

/** Every engine process started with utilityProcess.fork, oldest first. */
export const utilityProcesses: FakeUtilityProcess[] = [];

let nextBlockerId = 1;

export const electron = {
  app,
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      ipcHandlers.set(channel, handler);
    },
  },
  BrowserWindow: {
    getAllWindows: () => windows,
    fromWebContents: vi.fn((_contents: unknown): unknown => null),
  },
  dialog: { showOpenDialog: vi.fn() },
  nativeTheme: { themeSource: "system" },
  shell: {
    showItemInFolder: vi.fn(),
    openPath: vi.fn(() => Promise.resolve("")),
    // Never opens anything: tests only check what would have been opened.
    openExternal: vi.fn((_url: string) => Promise.resolve()),
  },
  net: {
    fetch: vi.fn((_url: string, _init?: RequestInit): Promise<Response> =>
      Promise.reject(new Error("net.fetch isn't faked in this test")),
    ),
  },
  protocol: {},
  utilityProcess: {
    fork: vi.fn(
      (
        modulePath: string,
        args: string[],
        options: Record<string, unknown>,
      ) => {
        const child = new FakeUtilityProcess(modulePath, args, options);
        utilityProcesses.push(child);
        return child;
      },
    ),
  },
  powerSaveBlocker: {
    start: vi.fn((_type: string) => nextBlockerId++),
    stop: vi.fn((_id: number) => true),
  },
};

/** Calls an IPC handler the way our UI would (from app://streamy). */
export function invoke(channel: string, ...args: unknown[]): unknown {
  return invokeFrom("app://streamy/index.html", channel, ...args);
}

/** Calls an IPC handler as if from a page at `url`. */
export function invokeFrom(
  url: string,
  channel: string,
  ...args: unknown[]
): unknown {
  return invokeAs({ url }, channel, ...args);
}

/** Calls an IPC handler from a given page (`url`) and WebContents (`sender`). */
export function invokeAs(
  { url = "app://streamy/", sender = {} }: { url?: string; sender?: unknown },
  channel: string,
  ...args: unknown[]
): unknown {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler for ${channel}`);
  return handler({ senderFrame: { url }, sender }, ...args);
}

/** Back to a clean state between tests. */
export function resetFakeElectron(): void {
  ipcHandlers.clear();
  windows.length = 0;
  utilityProcesses.length = 0;
  app.removeAllListeners();
  app.isPackaged = true;
  electron.nativeTheme.themeSource = "system";
}
