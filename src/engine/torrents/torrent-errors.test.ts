import { describe, expect, it } from "vitest";
import {
  CANT_WRITE,
  describeTorrentError,
  DISK_FULL,
  FILE_BUSY,
  SOMETHING_WRONG,
} from "./torrent-errors";

/** An error like Node's fs gives. */
function systemError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe("describeTorrentError", () => {
  it.each([
    ["ENOSPC", DISK_FULL],
    ["EDQUOT", DISK_FULL],
    ["EACCES", CANT_WRITE],
    ["EPERM", CANT_WRITE],
    ["EROFS", CANT_WRITE],
    ["EBUSY", FILE_BUSY],
    ["EIO", SOMETHING_WRONG],
  ])("%s → %j", (code, sentence) => {
    const err = systemError(
      code,
      `${code}: it failed, write '/Users/me/Videos/Movie/Movie.mkv'`,
    );
    expect(describeTorrentError(err)).toBe(sentence);
  });

  it("reads the code from the message when only the text was passed on", () => {
    expect(
      describeTorrentError(new Error("ENOSPC: no space left on device, write")),
    ).toBe(DISK_FULL);
  });

  it("never passes WebTorrent's own words on", () => {
    for (const err of [
      new Error(
        "Cannot add duplicate torrent 08ada5a7a6183aae1e09d831df6748d566095a10",
      ),
      "a string",
      null,
      { code: 42 },
    ]) {
      expect(describeTorrentError(err)).toBe(SOMETHING_WRONG);
    }
  });
});
