import { describe, expect, it, vi } from "vitest";
import type { Health } from "../shared/engine-api";
import { checkHealth, checkUi } from "./smoke";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

const HEALTH: Health = {
  version: "0.1.0",
  uptime: 2,
  ffmpeg: { version: "8.1.3-Jellyfin", error: null },
  encoder: null,
  lowDiskSpace: false,
};

describe("checkHealth (the smoke test's verdict)", () => {
  it("passes when ffmpeg's version is known", () => {
    expect(checkHealth(200, HEALTH)).toEqual({
      status: "pass",
      health: HEALTH,
    });
  });

  it("waits while ffmpeg is still being checked", () => {
    const checking = { ...HEALTH, ffmpeg: { version: null, error: null } };
    expect(checkHealth(200, checking)).toEqual({ status: "wait" });
  });

  it("fails when ffmpeg doesn't run", () => {
    const broken = {
      ...HEALTH,
      ffmpeg: { version: null, error: "spawn ffmpeg ENOENT" },
    };
    expect(checkHealth(200, broken)).toEqual({
      status: "fail",
      error: "ffmpeg doesn't work: spawn ffmpeg ENOENT",
    });
  });

  it("fails on an error status or an unexpected body", () => {
    expect(checkHealth(503, HEALTH)).toMatchObject({ status: "fail" });
    expect(checkHealth(200, { hello: "world" })).toMatchObject({
      status: "fail",
    });
    expect(checkHealth(200, null)).toMatchObject({ status: "fail" });
  });
});

describe("checkUi (did the UI really start?)", () => {
  /** A page whose scripts answer like the UI would. */
  function page({ streamy = "object", rootChildren = [1] as number[] }) {
    const counts = [...rootChildren];
    return {
      isLoading: () => false,
      once: vi.fn(),
      executeJavaScript: vi.fn((code: string) =>
        Promise.resolve(
          code.includes("window.streamy")
            ? streamy
            : ((counts.length > 1 ? counts.shift() : counts[0]) ?? 0),
        ),
      ),
    };
  }
  const fast = { renderMs: 50, pollMs: 5 };

  it("passes once React has drawn into #root", async () => {
    expect(
      await checkUi(page({ rootChildren: [0, 0, 1] }) as never, fast),
    ).toBeNull();
  });

  it("fails when the preload didn't load", async () => {
    expect(await checkUi(page({ streamy: "undefined" }) as never, fast)).toBe(
      "The UI's preload script didn't load",
    );
  });

  it("fails when the UI's bundle never rendered", async () => {
    expect(await checkUi(page({ rootChildren: [0] }) as never, fast)).toBe(
      "The UI didn't render (#root is empty)",
    );
  });
});
