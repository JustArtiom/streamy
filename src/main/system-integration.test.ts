import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSystemIntegration,
  setHandlesMagnetLinks,
  setOpenAtLogin,
} from "./system-integration";
import { electron, resetFakeElectron } from "./test/fake-electron";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

const realPlatform = process.platform;
function pretendPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

let config: string;

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "streamy-xdg-"));
  vi.stubEnv("XDG_CONFIG_HOME", config);
  vi.stubEnv("APPIMAGE", "/home/sam/Apps/Streamy $1.AppImage");
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.unstubAllEnvs();
  resetFakeElectron();
  rmSync(config, { recursive: true, force: true });
});

describe("in a dev build", () => {
  it("can't change anything (it would register Electron itself)", () => {
    electron.app.isPackaged = false;

    expect(setOpenAtLogin(true).available).toBe(false);
    expect(setHandlesMagnetLinks(true).available).toBe(false);
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(electron.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});

describe("on macOS", () => {
  beforeEach(() => {
    pretendPlatform("darwin");
  });

  it("uses the system login items", () => {
    setOpenAtLogin(true);

    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
    });
  });

  it("reports when the user still has to approve it", () => {
    electron.app.getLoginItemSettings.mockReturnValueOnce({
      openAtLogin: true,
      status: "requires-approval",
    });

    expect(getSystemIntegration()).toMatchObject({
      openAtLogin: true,
      openAtLoginNeedsApproval: true,
    });
  });

  it("registers and unregisters as the magnet app", () => {
    setHandlesMagnetLinks(true);
    setHandlesMagnetLinks(false);

    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      "magnet",
    );
    expect(electron.app.removeAsDefaultProtocolClient).toHaveBeenCalledWith(
      "magnet",
    );
  });
});

describe("on Linux", () => {
  beforeEach(() => {
    pretendPlatform("linux");
  });

  const autostart = () => join(config, "autostart", "streamy.desktop");

  it("opens at login through an autostart file", () => {
    expect(setOpenAtLogin(true).openAtLogin).toBe(true);
    expect(readFileSync(autostart(), "utf8")).toContain(
      // The AppImage path, quoted, with $ escaped as the spec requires.
      'Exec="/home/sam/Apps/Streamy \\$1.AppImage"',
    );

    expect(setOpenAtLogin(false).openAtLogin).toBe(false);
    expect(existsSync(autostart())).toBe(false);
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("doesn't try to unregister as the magnet app (Linux can't)", () => {
    setHandlesMagnetLinks(false);

    expect(electron.app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});
