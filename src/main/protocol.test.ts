import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  devServerOrigin,
  isAppUrl,
  noticesFile,
  resolveUiFile,
  routeAppRequest,
  uiUrl,
} from "./protocol";
import { electron, resetFakeElectron } from "./test/fake-electron";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

afterEach(() => {
  resetFakeElectron();
  vi.unstubAllEnvs();
});

describe("isAppUrl (who may call into the main process)", () => {
  it("trusts our own UI", () => {
    expect(isAppUrl("app://streamy/index.html")).toBe(true);
    expect(isAppUrl("app://streamy/assets/x.js")).toBe(true);
  });

  it.each([
    ["app://other/index.html"],
    ["https://example.com/"],
    ["file:///etc/passwd"],
    ["http://localhost:5173/"],
    ["not a url"],
    [""],
  ])("doesn't trust %j", (url) => {
    expect(isAppUrl(url)).toBe(false);
  });

  it("trusts the Vite dev server only in a dev build", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");

    electron.app.isPackaged = true;
    expect(isAppUrl("http://localhost:5173/")).toBe(false);

    electron.app.isPackaged = false;
    expect(isAppUrl("http://localhost:5173/")).toBe(true);
    expect(isAppUrl("http://localhost:5174/")).toBe(false);
    expect(uiUrl()).toBe("http://localhost:5173");
    expect(devServerOrigin()).toBe("http://localhost:5173");
  });

  it("loads the UI from the root, so the app's own routes work", () => {
    expect(uiUrl()).toBe("app://streamy/");
    expect(devServerOrigin()).toBeUndefined();
  });
});

describe("routeAppRequest (what app://streamy/ answers)", () => {
  const root = join(tmpdir(), "app", "out", "renderer");

  it("sends /api to the engine, keeping the encoding and the query", () => {
    expect(routeAppRequest(root, "app://streamy/api/v1/health")).toEqual({
      kind: "api",
      path: "/v1/health",
    });
    expect(
      routeAppRequest(root, "app://streamy/api/v1/torrents/a%20b?x=1&y=%2F"),
    ).toEqual({ kind: "api", path: "/v1/torrents/a%20b?x=1&y=%2F" });
    expect(routeAppRequest(root, "app://streamy/api")).toEqual({
      kind: "api",
      path: "/",
    });
  });

  it("serves files of the built UI", () => {
    expect(routeAppRequest(root, "app://streamy/assets/index-1.js")).toEqual({
      kind: "file",
      file: join(root, "assets", "index-1.js"),
    });
    expect(routeAppRequest(root, "app://streamy/")).toEqual({
      kind: "file",
      file: join(root, "index.html"),
    });
  });

  it.each([
    ["app://streamy/torrent/08ada5a7a6183aae1e09d831df6748d566095a10"],
    ["app://streamy/watch/08ada5a7a6183aae1e09d831df6748d566095a10/3"],
    ["app://streamy/apis"],
    ["app://streamy/settings?tab=storage"],
  ])("answers the app's own routes with index.html: %s", (url) => {
    expect(routeAppRequest(root, url)).toEqual({
      kind: "file",
      file: join(root, "index.html"),
    });
  });

  it.each([
    ["app://streamy/..%2F..%2Fetc%2Fpasswd"],
    ["app://streamy/%2e%2e%2f%2e%2e%2fetc/passwd"],
    ["app://streamy/assets/..%2F..%2F..%2Fsecret.txt"],
  ])("never escapes the UI folder: %s", (url) => {
    expect(routeAppRequest(root, url)).toEqual({
      kind: "status",
      status: 403,
    });
  });

  it("serves the third-party licences from outside the UI folder", () => {
    expect(
      routeAppRequest(root, "app://streamy/third-party-notices.txt"),
    ).toEqual({ kind: "notices" });
  });

  it("refuses other hosts", () => {
    expect(routeAppRequest(root, "app://other/api/v1/health")).toEqual({
      kind: "status",
      status: 404,
    });
  });
});

describe("noticesFile (THIRD_PARTY_NOTICES.txt)", () => {
  it("is in resources/ when packaged, and in vendor/ in dev", () => {
    // Electron sets process.resourcesPath; plain Node doesn't have it.
    Object.defineProperty(process, "resourcesPath", {
      value: "/opt/Streamy/resources",
      configurable: true,
    });
    try {
      expect(noticesFile()).toBe(
        join("/opt/Streamy/resources", "THIRD_PARTY_NOTICES.txt"),
      );
    } finally {
      Reflect.deleteProperty(process, "resourcesPath");
    }

    electron.app.isPackaged = false;
    expect(noticesFile()).toBe(
      join("/fake/app", "vendor", "THIRD_PARTY_NOTICES.txt"),
    );
  });
});

describe("resolveUiFile (what app:// may serve)", () => {
  const root = join(tmpdir(), "app", "out", "renderer");

  it("serves files from the UI folder", () => {
    expect(resolveUiFile(root, "app://streamy/assets/index.js")).toEqual({
      file: join(root, "assets", "index.js"),
    });
    expect(resolveUiFile(root, "app://streamy/")).toEqual({
      file: join(root, "index.html"),
    });
  });

  it.each([
    ["app://streamy/..%2F..%2Fetc%2Fpasswd"],
    ["app://streamy/%2e%2e%2f%2e%2e%2fetc/passwd"],
    ["app://streamy/assets/..%2F..%2F..%2Fsecret"],
    ["app://streamy/..%5C..%5Cwindows%5Csystem.ini"],
  ])("never escapes the UI folder: %s", (url) => {
    const resolved = resolveUiFile(root, url);
    if ("file" in resolved) {
      expect(relative(root, resolved.file).startsWith("..")).toBe(false);
    } else {
      expect(resolved.status).toBe(403);
    }
  });

  it("refuses other hosts and broken encodings", () => {
    expect(resolveUiFile(root, "app://other/index.html")).toEqual({
      status: 404,
    });
    expect(resolveUiFile(root, "app://streamy/%E0%A4%A")).toEqual({
      status: 400,
    });
  });
});
