import { EventEmitter } from "node:events";
import { vi } from "vitest";

// A small stand-in for the parts of Electron the main-process code uses, so
// it can be tested in plain Node. Use it with:
//   vi.mock("electron", async () => (await import("../test/fake-electron")).electron);

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** IPC handlers registered with ipcMain.handle, by channel. */
export const ipcHandlers = new Map<string, Handler>();

/** A window with just enough of BrowserWindow / WebContents for our code. */
export function createFakeWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
    setZoomFactor: vi.fn<(factor: number) => void>(),
    isLoading: vi.fn(() => false),
  });
  return { webContents };
}

const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  getName: () => "Streamy",
  getVersion: () => "0.0.0-test",
  getPath: vi.fn((name: string) => `/fake/${name}`),
  isHardwareAccelerationEnabled: vi.fn(() => true),
  relaunch: vi.fn(),
  quit: vi.fn(),
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

export const electron = {
  app,
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      ipcHandlers.set(channel, handler);
    },
  },
  BrowserWindow: {
    getAllWindows: () => windows,
    fromWebContents: () => null,
  },
  dialog: { showOpenDialog: vi.fn() },
  nativeTheme: { themeSource: "system" },
  shell: {
    showItemInFolder: vi.fn(),
    openPath: vi.fn(() => Promise.resolve("")),
  },
  net: {},
  protocol: {},
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
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler for ${channel}`);
  return handler({ senderFrame: { url }, sender: {} }, ...args);
}

/** Back to a clean state between tests. */
export function resetFakeElectron(): void {
  ipcHandlers.clear();
  windows.length = 0;
  app.removeAllListeners();
  app.isPackaged = true;
  electron.nativeTheme.themeSource = "system";
}
