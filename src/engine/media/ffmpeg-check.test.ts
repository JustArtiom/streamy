import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRuntime } from "../config";
import { findFfmpeg, useTestRuntime } from "../test/runtime";
import {
  checkFfmpeg,
  ffmpegStatus,
  parseFfmpegVersion,
  resetFfmpegCheckForTests,
} from "./ffmpeg-check";

describe("parseFfmpegVersion", () => {
  it.each([
    [
      "ffmpeg version 8.1.3-Jellyfin Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with clang",
      "8.1.3-Jellyfin",
    ],
    ["ffmpeg version 8.0 Copyright (c) 2000-2025", "8.0"],
    ["ffprobe version n7.1-12-gabc Copyright", "n7.1-12-gabc"],
    ["something else entirely", null],
  ])("%j → %s", (output, version) => {
    expect(parseFfmpegVersion(output)).toBe(version);
  });
});

describe("checkFfmpeg", () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ cleanup } = await useTestRuntime());
    resetFfmpegCheckForTests();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("reports null/null until it ran", () => {
    expect(ffmpegStatus()).toEqual({ version: null, error: null });
  });

  it.runIf(findFfmpeg() !== null)(
    "reads the version of a working ffmpeg",
    async () => {
      const status = await checkFfmpeg();
      expect(status.error).toBeNull();
      expect(status.version).toMatch(/^\S+$/);
      expect(ffmpegStatus()).toEqual(status);
    },
  );

  it("says what's wrong in plain words when ffmpeg is missing", async () => {
    getRuntime().ffmpegPath = "/no/such/ffmpeg";

    const status = await checkFfmpeg();

    // No path or exit code: those go to the log.
    expect(status).toEqual({
      version: null,
      error:
        "ffmpeg is missing or can't run. Reinstalling Streamy should fix it.",
    });
  });
});
