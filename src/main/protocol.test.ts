import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAppUrl, resolveUiFile, uiUrl } from "./protocol";
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
