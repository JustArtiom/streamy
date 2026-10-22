import { describe, expect, it } from "vitest";
import { MAX_TORRENT_FILES } from "../config";
import {
  hasCollidingPaths,
  isUnsafePath,
  rawPaths,
  torrentContentsProblem,
  UNSAFE_NAMES_MESSAGE,
} from "./contents";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("isUnsafePath", () => {
  it.each([
    // Climbing out of the folder, or not in it at all.
    ["../x", true],
    ["a/../../x", true],
    ["a\\..\\x", true],
    ["/etc/passwd", true],
    ["C:\\Windows\\x", true],
    ["c:x", true],
    // Windows devices, with or without an extension, any case.
    ["Show/CON", true],
    ["Show/nul.txt", true],
    ["Show/Com1.mkv", true],
    ["LPT9/a.mkv", true],
    ["Show/aux .srt", true],
    ["Show/CONIN$", true],
    // Dropped by Windows (and so colliding), or alternate data streams.
    ["Show/movie.", true],
    ["Show/movie ", true],
    ["Show /movie.mkv", true],
    ["Show/movie.mkv:hidden", true],
    // Control characters.
    ["Show/a\u0007b.mkv", true],
    ["Show/a\nb.mkv", true],
    // Fine.
    ["Movie/movie.mkv", false],
    ["Movie..mkv", false],
    ["..hidden/file", false],
    ["Show/./a.mkv", false],
    ["Show/CONSOLE.mkv", false],
    ["Show/com10.mkv", false],
    ["Show/a?.mkv", false],
    ["Фильм/фильм.mkv", false],
  ])("isUnsafePath(%j) is %s", (path, unsafe) => {
    expect(isUnsafePath(path)).toBe(unsafe);
  });
});

describe("hasCollidingPaths", () => {
  it.each([
    // One file on case-insensitive disks (macOS, Windows).
    [["Show/Subs.srt", "Show/subs.srt"], true],
    [["Show/a.mkv", "SHOW/b.mkv", "show/A.MKV"], true],
    // One file everywhere: the store strips <>:"/\|?* from file names.
    [["Show/a?.mkv", "Show/a*.mkv"], true],
    [["Show/a<b>.mkv", "Show/ab.mkv"], true],
    // Windows drops trailing dots and spaces (after the stripping).
    [["Show/a.?", "Show/a"], true],
    // Two ways of writing é (macOS doesn't tell them apart).
    [["Show/caf\u00e9.mkv", "Show/cafe\u0301.mkv"], true],
    // A file where another file needs a folder.
    [["Show/a", "Show/a/b.mkv"], true],
    [["Show/a/b.mkv", "Show/A"], true],
    // A name that's nothing once stripped, or a device.
    [["Show/???"], true],
    [["Show/CON?"], true],
    // Fine.
    [["Show/a.mkv", "Show/b.mkv", "Show/a/b.mkv"], false],
    [["Show/Subs/en.srt", "Show/Subs/fr.srt", "Show/Subs.mkv"], false],
    [["a.mkv"], false],
  ])("%j: %s", (paths, colliding) => {
    expect(hasCollidingPaths(paths)).toBe(colliding);
  });
});

describe("rawPaths", () => {
  it("reads what the torrent declares, before WebTorrent tidies it", () => {
    expect(
      rawPaths({
        name: bytes("Show"),
        files: [
          { path: [bytes(".."), bytes("x")] },
          { "path.utf-8": [bytes("é.mkv")], path: [bytes("e.mkv")] },
        ],
      }),
    ).toEqual(["Show", "Show/../x", "Show/é.mkv"]);
    expect(rawPaths(undefined)).toEqual([]);
  });
});

describe("torrentContentsProblem", () => {
  it("is null for a normal torrent", () => {
    expect(
      torrentContentsProblem({
        files: ["Sintel/Sintel.mp4", "Sintel/Sintel.en.srt"],
        info: undefined,
      }),
    ).toBeNull();
  });

  it("refuses unsafe raw names, even when WebTorrent's own paths look fine", () => {
    expect(
      torrentContentsProblem({
        files: ["Evil/movie.mp4"],
        info: {
          name: bytes("Evil"),
          files: [{ path: [bytes(".."), bytes(".."), bytes("movie.mp4")] }],
        },
      }),
    ).toBe(UNSAFE_NAMES_MESSAGE);
  });

  it("refuses colliding files", () => {
    expect(
      torrentContentsProblem({
        files: ["Show/Subs.srt", "Show/subs.srt"],
        info: undefined,
      }),
    ).toBe(UNSAFE_NAMES_MESSAGE);
  });

  it("refuses too many files, saying how many", () => {
    const files = Array.from(
      { length: MAX_TORRENT_FILES + 1 },
      (_, i) => `x/${i}`,
    );
    expect(torrentContentsProblem({ files, info: undefined })).toBe(
      "This torrent has too many files (10,001). Streamy opens torrents with up to 10,000 files.",
    );
  });
});
