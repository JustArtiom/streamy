import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appImagePath, type BuildFacts, updateMode } from "./mode";

const RESOURCES = join("/apps", "Streamy", "resources");
const EXE = join("/apps", "Streamy", "Streamy.exe");

/** An installed, packaged build; each test changes what it's about. */
function facts(overrides: Partial<BuildFacts> = {}): BuildFacts {
  const files = new Set([
    join(RESOURCES, "app-update.yml"),
    join("/apps", "Streamy", "Uninstall Streamy.exe"),
  ]);
  return {
    platform: "win32",
    isPackaged: true,
    smoke: false,
    appName: "Streamy",
    env: {},
    resourcesPath: RESOURCES,
    execPath: EXE,
    exists: (path) => files.has(path),
    canWrite: () => true,
    ...overrides,
  };
}

/** Running from an AppImage: what its runtime sets up. */
const APPIMAGE_RUN = {
  platform: "linux",
  env: {
    APPIMAGE: "/home/me/Apps/Streamy-x86_64.AppImage",
    APPDIR: "/tmp/.mount_StreamABC",
  },
  execPath: "/tmp/.mount_StreamABC/streamy",
} satisfies Partial<BuildFacts>;

describe("updateMode (which updates this copy of Streamy gets)", () => {
  it("installs updates itself from the Windows installer", () => {
    expect(updateMode(facts())).toEqual({
      mode: "auto",
      reason: "Windows installer",
    });
  });

  it("installs updates itself as an AppImage", () => {
    expect(updateMode(facts(APPIMAGE_RUN)).mode).toBe("auto");
  });

  it("only tells about new versions when the AppImage's folder isn't writable", () => {
    const canWrite = vi.fn(() => false);
    expect(updateMode(facts({ ...APPIMAGE_RUN, canWrite }))).toEqual({
      mode: "notify",
      reason: "AppImage folder isn't writable",
    });
    expect(canWrite).toHaveBeenCalledWith("/home/me/Apps");
  });

  it("only tells about new versions on macOS (not signed)", () => {
    expect(updateMode(facts({ platform: "darwin" })).mode).toBe("notify");
  });

  it.each<[string, Partial<BuildFacts>]>([
    ["a dev build", { isPackaged: false }],
    ["a dev build on macOS", { isPackaged: false, platform: "darwin" }],
    ["the smoke test", { smoke: true }],
    ["the smoke test on macOS", { smoke: true, platform: "darwin" }],
    ["the .deb (no APPIMAGE)", { platform: "linux" }],
    ["a portable Windows build", { env: { PORTABLE_EXECUTABLE_DIR: "C:\\x" } }],
    ["an unpacked Windows folder", { exists: (path) => path.endsWith(".yml") }],
    ["a build without app-update.yml", { exists: () => false }],
    [
      "an AppImage without app-update.yml",
      { ...APPIMAGE_RUN, exists: () => false },
    ],
    [
      // Started from another AppImage, which passed its variables on.
      "the .deb with another app's APPIMAGE",
      { ...APPIMAGE_RUN, execPath: "/opt/Streamy/streamy" },
    ],
    ["another OS", { platform: "freebsd" }],
  ])("doesn't update %s", (_what, overrides) => {
    expect(updateMode(facts(overrides)).mode).toBe("unsupported");
  });
});

describe("appImagePath (is this Streamy running from an AppImage?)", () => {
  const env = {
    APPIMAGE: "/home/me/Streamy-x86_64.AppImage",
    APPDIR: "/tmp/.mount_Stream1",
  };

  it("gives the .AppImage file when Streamy runs from its mount", () => {
    expect(appImagePath(env, "/tmp/.mount_Stream1/streamy")).toBe(
      "/home/me/Streamy-x86_64.AppImage",
    );
    expect(
      appImagePath(
        { ...env, APPDIR: "/tmp/.mount_Stream1/" },
        "/tmp/.mount_Stream1/streamy",
      ),
    ).toBe("/home/me/Streamy-x86_64.AppImage");
  });

  it("ignores variables another AppImage passed on", () => {
    expect(appImagePath(env, "/opt/Streamy/streamy")).toBeNull();
    // A mount whose name only starts the same.
    expect(appImagePath(env, "/tmp/.mount_Stream12/streamy")).toBeNull();
  });

  it("needs both variables, and an absolute file", () => {
    expect(appImagePath({ APPIMAGE: env.APPIMAGE }, "/x/streamy")).toBeNull();
    expect(
      appImagePath({ APPDIR: env.APPDIR }, "/tmp/.mount_Stream1/streamy"),
    ).toBeNull();
    expect(
      appImagePath(
        { ...env, APPIMAGE: "Streamy.AppImage" },
        "/tmp/.mount_Stream1/streamy",
      ),
    ).toBeNull();
  });
});
