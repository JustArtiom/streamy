import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcChannel } from "../shared/api";
import {
  findMagnetLink,
  isMagnetLink,
  receiveMagnetLinks,
} from "./magnet-links";
import {
  createFakeWindow,
  electron,
  resetFakeElectron,
} from "./test/fake-electron";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

afterEach(() => {
  resetFakeElectron();
});

const LINK = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10";

describe("isMagnetLink / findMagnetLink", () => {
  it("recognizes magnet links", () => {
    expect(isMagnetLink(LINK)).toBe(true);
    expect(isMagnetLink(LINK.replace("magnet", "MAGNET"))).toBe(true);
  });

  it.each([["https://example.com"], ["magnet:"], ["xmagnet:?xt=1"], [""]])(
    "ignores %j",
    (value) => {
      expect(isMagnetLink(value)).toBe(false);
    },
  );

  it("ignores absurdly long input", () => {
    expect(isMagnetLink(`magnet:?${"a".repeat(20_000)}`)).toBe(false);
  });

  it("finds the link among command line arguments", () => {
    expect(findMagnetLink(["/opt/Streamy/streamy", "--flag", LINK])).toBe(LINK);
    expect(findMagnetLink(["/opt/Streamy/streamy"])).toBeUndefined();
  });
});

describe("receiveMagnetLinks", () => {
  function setup() {
    const window = createFakeWindow();
    const showWindow = vi.fn(() => window.webContents as never);
    const links = receiveMagnetLinks({ showWindow });
    return { window, showWindow, links };
  }

  it("keeps a link that arrives during startup until the app is ready", () => {
    const { window, links } = setup();
    const event = { preventDefault: vi.fn() };

    electron.app.emit("open-url", event, LINK); // macOS
    expect(event.preventDefault).toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalled();

    links.start();
    expect(window.webContents.send).toHaveBeenCalledWith(
      IpcChannel.MagnetLinkOpened,
      LINK,
    );
  });

  it("waits for the page to load before handing the link over", () => {
    const { window, links } = setup();
    links.start();
    window.webContents.isLoading.mockReturnValue(true);

    links.fromArgv(["streamy", LINK]); // Windows/Linux second launch
    expect(window.webContents.send).not.toHaveBeenCalled();

    window.webContents.emit("did-finish-load");
    expect(window.webContents.send).toHaveBeenCalledWith(
      IpcChannel.MagnetLinkOpened,
      LINK,
    );
  });

  it("ignores anything that isn't a magnet link", () => {
    const { showWindow, links } = setup();
    links.start();

    electron.app.emit("open-url", { preventDefault: vi.fn() }, "https://x.y");
    links.fromArgv(["streamy", "--inspect"]);

    expect(showWindow).not.toHaveBeenCalled();
  });
});
