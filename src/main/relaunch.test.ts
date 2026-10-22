import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relaunchOptions } from "./relaunch";
import { resetFakeElectron } from "./test/fake-electron";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.unstubAllEnvs();
  resetFakeElectron();
});

const ARGS = [
  ".", // dev: the app's folder
  "--user-data-dir=/tmp/profile",
  "magnet:?xt=urn:btih:abc&dn=x",
  "show.torrent",
];

describe("relaunchOptions", () => {
  it("drops what was opened already (a restart must not open it again)", () => {
    expect(
      relaunchOptions(ARGS, { keepOpened: false, cwd: "/home/me" }).args,
    ).toEqual([".", "--user-data-dir=/tmp/profile"]);
  });

  it("keeps a launch's links and files, with absolute paths", () => {
    expect(
      relaunchOptions(ARGS, { keepOpened: true, cwd: "/home/me/Downloads" })
        .args,
    ).toEqual([
      ".",
      "--user-data-dir=/tmp/profile",
      "magnet:?xt=urn:btih:abc&dn=x",
      resolve("/home/me/Downloads", "show.torrent"),
    ]);
  });

  it("starts the .AppImage file, not its temporary mount", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("APPIMAGE", "/home/me/Streamy-x86_64.AppImage");
    vi.stubEnv("APPDIR", dirname(process.execPath));

    expect(relaunchOptions([], { keepOpened: false, cwd: "/" }).execPath).toBe(
      "/home/me/Streamy-x86_64.AppImage",
    );

    // Another AppImage's variables don't count.
    vi.stubEnv("APPDIR", "/tmp/.mount_Other1");
    expect(
      relaunchOptions([], { keepOpened: false, cwd: "/" }),
    ).not.toHaveProperty("execPath");
  });
});
