import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autostartExecutable,
  getSystemIntegration,
  moveLinuxAutostart,
  repairLinuxAutostart,
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

const APPIMAGE = "/home/sam/Apps/Streamy $1.AppImage";

/** Runs "from an AppImage": its runtime mounts it where Streamy's executable is. */
function runFromAppImage() {
  vi.stubEnv("APPIMAGE", APPIMAGE);
  vi.stubEnv("APPDIR", dirname(process.execPath));
}

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "streamy-xdg-"));
  vi.stubEnv("XDG_CONFIG_HOME", config);
  vi.stubEnv("APPIMAGE", "");
  vi.stubEnv("APPDIR", "");
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

describe("in test mode (STREAMY_TEST_MODE=1, the e2e tests)", () => {
  it("never changes the OS, even when packaged", () => {
    electron.app.isPackaged = true;
    vi.stubEnv("STREAMY_TEST_MODE", "1");

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
  const writeAutostart = (exec: string) => {
    mkdirSync(dirname(autostart()), { recursive: true });
    writeFileSync(autostart(), `[Desktop Entry]\nExec=${exec}\n`);
  };

  it("opens at login through an autostart file", () => {
    runFromAppImage();
    expect(setOpenAtLogin(true).openAtLogin).toBe(true);
    expect(readFileSync(autostart(), "utf8")).toContain(
      // The AppImage path, quoted, with $ escaped as the spec requires.
      'Exec="/home/sam/Apps/Streamy \\$1.AppImage"',
    );

    expect(setOpenAtLogin(false).openAtLogin).toBe(false);
    expect(existsSync(autostart())).toBe(false);
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("starts its own executable when another AppImage passed APPIMAGE on", () => {
    vi.stubEnv("APPIMAGE", "/home/sam/Apps/SomethingElse.AppImage");
    vi.stubEnv("APPDIR", "/tmp/.mount_Someth1");

    setOpenAtLogin(true);

    expect(autostartExecutable(readFileSync(autostart(), "utf8"))).toBe(
      process.execPath,
    );
  });

  it("doesn't try to unregister as the magnet app (Linux can't)", () => {
    setHandlesMagnetLinks(false);

    expect(electron.app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("never registers the AppImage as the magnet app (it has no .desktop file)", () => {
    runFromAppImage();

    const system = setHandlesMagnetLinks(true);

    expect(electron.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    // So Settings can say why instead of a switch that flips back.
    expect(system.canHandleMagnetLinks).toBe(false);
  });

  it("can be the magnet app when installed from the .deb", () => {
    expect(getSystemIntegration().canHandleMagnetLinks).toBe(true);
  });

  it("follows the AppImage when an update renames it", () => {
    runFromAppImage();
    setOpenAtLogin(true);

    moveLinuxAutostart("/home/sam/Apps/Streamy-x86_64.AppImage");

    expect(autostartExecutable(readFileSync(autostart(), "utf8"))).toBe(
      "/home/sam/Apps/Streamy-x86_64.AppImage",
    );
  });

  it("doesn't turn Open at login on when following a rename", () => {
    moveLinuxAutostart("/home/sam/Apps/Streamy-x86_64.AppImage");

    expect(existsSync(autostart())).toBe(false);
  });

  describe("repairing Open at login at startup", () => {
    it("points an entry for a file that's gone at this copy", () => {
      runFromAppImage();
      writeAutostart('"/home/sam/Apps/Streamy-0.1.0-x86_64.AppImage"');

      expect(repairLinuxAutostart(() => false)).toBe(true);
      expect(autostartExecutable(readFileSync(autostart(), "utf8"))).toBe(
        APPIMAGE,
      );
    });

    it("leaves an entry for another copy that still exists", () => {
      runFromAppImage();
      writeAutostart('"/opt/Streamy/streamy"');

      expect(repairLinuxAutostart(() => true)).toBe(false);
      expect(readFileSync(autostart(), "utf8")).toContain("/opt/Streamy");
    });

    it("leaves entries it didn't write, and does nothing while it's off", () => {
      writeAutostart("streamy --hidden");
      expect(repairLinuxAutostart(() => false)).toBe(false);
      expect(readFileSync(autostart(), "utf8")).toContain("--hidden");

      rmSync(autostart());
      expect(repairLinuxAutostart(() => false)).toBe(false);
      expect(existsSync(autostart())).toBe(false);
    });
  });
});

describe("autostartExecutable", () => {
  it("reads back what Streamy wrote, quotes and all", () => {
    expect(
      autostartExecutable('[Desktop Entry]\nExec="/a \\"b\\" \\$c\\\\d"\n'),
    ).toBe('/a "b" $c\\d');
    expect(autostartExecutable("Exec=/usr/bin/streamy")).toBeNull();
  });
});
