import { describe, expect, it } from "vitest";
import {
  blockingReloadLimitMs,
  hasSegment,
  parsePlaylist,
  producedUntil,
  SERVER_CONTROL_TAG,
  withBlockingReload,
} from "./playlist";

const EVENT = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.000000,
seg_00000.m4s
#EXTINF:10.000000,
seg_00001.m4s
#EXTINF:9.840000,
seg_00002.m4s
`;

describe("parsePlaylist", () => {
  it("sums #EXTINF durations of a playlist still being written", () => {
    expect(parsePlaylist(EVENT)).toEqual({
      segments: 3,
      duration: 29.84,
      ended: false,
      mediaSequence: 0,
      targetDuration: 10,
    });
  });

  it("sees #EXT-X-ENDLIST", () => {
    expect(parsePlaylist(`${EVENT}#EXT-X-ENDLIST\n`).ended).toBe(true);
  });

  it("handles an empty or header-only playlist", () => {
    expect(parsePlaylist("")).toEqual({
      segments: 0,
      duration: 0,
      ended: false,
      mediaSequence: 0,
      targetDuration: null,
    });
    expect(parsePlaylist("#EXTM3U\n#EXT-X-VERSION:7\n").segments).toBe(0);
  });

  it("ignores a broken #EXTINF line", () => {
    expect(parsePlaylist("#EXTINF:abc,\nseg_00000.m4s\n").segments).toBe(0);
  });
});

describe("producedUntil", () => {
  it("is offset + Σ #EXTINF", () => {
    expect(producedUntil(20, parsePlaylist(EVENT))).toBe(49.84);
    expect(producedUntil(0, parsePlaylist(""))).toBe(0);
  });
});

describe("hasSegment", () => {
  it("counts from the media sequence", () => {
    const playlist = parsePlaylist(EVENT);
    expect(hasSegment(playlist, 2)).toBe(true);
    expect(hasSegment(playlist, 3)).toBe(false);
    const later = parsePlaylist(
      EVENT.replace("#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-MEDIA-SEQUENCE:5"),
    );
    expect(later.mediaSequence).toBe(5);
    expect(hasSegment(later, 7)).toBe(true);
    expect(hasSegment(later, 8)).toBe(false);
  });
});

describe("blockingReloadLimitMs", () => {
  it("is 3 target durations, at most 12 s", () => {
    expect(
      blockingReloadLimitMs(parsePlaylist("#EXT-X-TARGETDURATION:2\n")),
    ).toBe(6000);
    expect(blockingReloadLimitMs(parsePlaylist(EVENT))).toBe(12_000);
    expect(blockingReloadLimitMs(null)).toBe(12_000);
  });
});

describe("withBlockingReload", () => {
  it("adds CAN-BLOCK-RELOAD right after the target duration", () => {
    const served = withBlockingReload(EVENT);
    expect(served).toBe(
      EVENT.replace(
        "#EXT-X-TARGETDURATION:10\n",
        `#EXT-X-TARGETDURATION:10\n${SERVER_CONTROL_TAG}\n`,
      ),
    );
    // Once is enough.
    expect(withBlockingReload(served)).toBe(served);
  });

  it("keeps CRLF line endings", () => {
    const crlf = EVENT.replaceAll("\n", "\r\n");
    expect(withBlockingReload(crlf)).toContain(
      `#EXT-X-TARGETDURATION:10\r\n${SERVER_CONTROL_TAG}\r\n`,
    );
  });

  it("leaves a finished playlist (and one without a target duration) alone", () => {
    const ended = `${EVENT}#EXT-X-ENDLIST\n`;
    expect(withBlockingReload(ended)).toBe(ended);
    expect(withBlockingReload("#EXTM3U\n")).toBe("#EXTM3U\n");
  });
});
