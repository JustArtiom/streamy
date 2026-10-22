import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  looksTechnical,
  peopleText,
  SOMETHING_WENT_WRONG,
} from "@/lib/people-text";

beforeEach(() => {
  // The original text goes to the console; not worth printing in tests.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("looksTechnical", () => {
  it.each([
    ["an errno code", "ENOSPC: no space left on device, write"],
    ["a code without a colon", "spawn ffmpeg ENOENT"],
    ["a refused connection", "connect ECONNREFUSED 127.0.0.1:3053"],
    ["a JavaScript error", "TypeError: Cannot read properties of undefined"],
    ["an error prefix", "Error: something broke"],
    ["Unexpected error", "Unexpected error while opening the torrent"],
    ["a JSON parse error", "Unexpected token < in JSON at position 0"],
    ["a missing function", "torrent.files.map is not a function"],
    ["undefined", "Can't open undefined"],
    ["a stack trace", "Failed\n    at open (/app/out/main/index.js:12:3)"],
    ["a file and line", "boom (index.js:12:34)"],
    ["a macOS path", "Couldn't write /Users/ann/Library/Caches/Streamy/x"],
    ["a Linux path", "open '/home/ann/.cache/streamy' failed"],
    ["a Windows path", "Couldn't write C:\\Users\\ann\\AppData\\x"],
    ["an ffmpeg log line", "[h264 @ 0x7f8a1c00] error while decoding"],
    ["nothing at all", "   "],
    ["a wall of text", "word ".repeat(120)],
    ["a log dump", "one\ntwo\nthree\nfour\nfive"],
  ])("catches %s", (_kind, text) => {
    expect(looksTechnical(text)).toBe(true);
  });

  it.each([
    "The disk is almost full.",
    "The playback engine stopped unexpectedly.",
    "Too many videos are being converted right now. Try again in a moment.",
    "ffmpeg is missing or can't run, so some videos can't play.",
    "Couldn't reach GitHub. Check your internet connection.",
    "Streamy can't save files in that folder.",
    "Audio / subtitles / quality: 1/2 speed at 10 MB/s",
    "This torrent has no video (only .nfo and .txt files).",
  ])("lets a sentence through: %s", (text) => {
    expect(looksTechnical(text)).toBe(false);
  });
});

describe("peopleText", () => {
  it("shows sentences for people as they are", () => {
    expect(peopleText("  The disk is almost full. ")).toBe(
      "The disk is almost full.",
    );
  });

  it("shows the fallback instead of developer text, and logs it once", () => {
    const warn = vi.mocked(console.warn);

    expect(peopleText("EACCES: permission denied, open '/x/y'")).toBe(
      SOMETHING_WENT_WRONG,
    );
    expect(
      peopleText("spawn ffmpeg ENOENT", "ffmpeg isn't installed right."),
    ).toBe("ffmpeg isn't installed right.");
    peopleText("spawn ffmpeg ENOENT");

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      "spawn ffmpeg ENOENT",
    );
  });

  it("uses the fallback when there's no text", () => {
    expect(peopleText(null, "Nothing to say.")).toBe("Nothing to say.");
    expect(peopleText(undefined)).toBe(SOMETHING_WENT_WRONG);
  });
});
