import { describe, expect, it } from "vitest";
import {
  bufferedAhead,
  clampSeekTarget,
  decideSeek,
  mergeProducedUntil,
  movieTime,
  nextFallback,
  toMovieRanges,
} from "@/components/player/playback-logic";

describe("movieTime", () => {
  it("is the session offset plus the video's own time", () => {
    // ffmpeg started at the keyframe at 20 s; hls.js plays it from 0.
    expect(movieTime(20, 3)).toBe(23);
    expect(movieTime(0, 61.5)).toBe(61.5);
  });

  it("treats an unknown currentTime as the session start", () => {
    expect(movieTime(20, NaN)).toBe(20);
  });
});

describe("clampSeekTarget", () => {
  it("keeps targets inside [0, duration - 0.5]", () => {
    expect(clampSeekTarget(-10, 100)).toBe(0);
    expect(clampSeekTarget(50, 100)).toBe(50);
    expect(clampSeekTarget(100, 100)).toBe(99.5);
    expect(clampSeekTarget(NaN, 100)).toBe(0);
  });

  it("never goes negative for tiny durations", () => {
    expect(clampSeekTarget(5, 0.2)).toBe(0);
  });
});

describe("decideSeek", () => {
  const hls = {
    duration: 600,
    mode: "remux" as const,
    offset: 20,
    seekableUntil: 80,
  };

  it("seeks anywhere in a direct session", () => {
    expect(
      decideSeek({
        target: 500,
        duration: 600,
        mode: "direct",
        offset: 0,
        seekableUntil: null,
      }),
    ).toEqual({ kind: "local", currentTime: 500 });
  });

  it("seeks inside what an HLS session has produced, in session time", () => {
    expect(decideSeek({ ...hls, target: 50 })).toEqual({
      kind: "local",
      currentTime: 30,
    });
    expect(decideSeek({ ...hls, target: 20 })).toEqual({
      kind: "local",
      currentTime: 0,
    });
  });

  it("starts a new session before the session's start", () => {
    expect(decideSeek({ ...hls, target: 19 })).toEqual({
      kind: "session",
      start: 19,
    });
  });

  it("starts a new session past (or right at) the produced edge", () => {
    expect(decideSeek({ ...hls, target: 79.5 })).toEqual({
      kind: "session",
      start: 79.5,
    });
    expect(decideSeek({ ...hls, target: 300 })).toEqual({
      kind: "session",
      start: 300,
    });
    expect(decideSeek({ ...hls, target: 79 })).toEqual({
      kind: "local",
      currentTime: 59,
    });
  });

  it("starts a new session while nothing is known to be produced yet", () => {
    expect(decideSeek({ ...hls, seekableUntil: null, target: 30 })).toEqual({
      kind: "session",
      start: 30,
    });
  });

  it("clamps the target before deciding", () => {
    expect(decideSeek({ ...hls, target: 9999 })).toEqual({
      kind: "session",
      start: 599.5,
    });
  });
});

describe("mergeProducedUntil", () => {
  it("takes the furthest known value and ignores unknowns", () => {
    expect(mergeProducedUntil(null, 40, undefined, 36)).toBe(40);
    expect(mergeProducedUntil(null, undefined)).toBeNull();
    expect(mergeProducedUntil(NaN, 12)).toBe(12);
  });
});

describe("buffered ranges", () => {
  const ranges = {
    length: 2,
    start: (i: number) => [0, 40][i] ?? 0,
    end: (i: number) => [10, 55][i] ?? 0,
  };

  it("converts session time ranges to movie time", () => {
    expect(toMovieRanges(ranges, 20)).toEqual([
      { start: 20, end: 30 },
      { start: 60, end: 75 },
    ]);
  });

  it("measures how much is ready ahead of the playhead", () => {
    const movie = toMovieRanges(ranges, 20);
    expect(bufferedAhead(movie, 25)).toBe(5);
    expect(bufferedAhead(movie, 59.8)).toBeCloseTo(15.2);
    expect(bufferedAhead(movie, 45)).toBe(0);
  });
});

describe("nextFallback", () => {
  const base = {
    forceMode: null,
    recovered: false,
    usingHlsJs: true,
    networkRestarts: 0,
    canConvert: true,
  };

  it("repackages a file the browser can't play directly", () => {
    expect(
      nextFallback({
        ...base,
        mode: "direct",
        kind: "media",
        usingHlsJs: false,
      }),
    ).toEqual({ action: "restart", forceMode: "remux" });
  });

  it("gives up on direct when the engine can't convert", () => {
    expect(
      nextFallback({
        ...base,
        mode: "direct",
        kind: "media",
        usingHlsJs: false,
        canConvert: false,
      }),
    ).toEqual({ action: "give-up" });
  });

  it("asks hls.js to recover once, then converts the video", () => {
    expect(nextFallback({ ...base, mode: "remux", kind: "media" })).toEqual({
      action: "recover",
    });
    expect(
      nextFallback({ ...base, mode: "remux", kind: "media", recovered: true }),
    ).toEqual({ action: "restart", forceMode: "transcode" });
  });

  it("gives up after transcoding fails too", () => {
    expect(
      nextFallback({
        ...base,
        mode: "transcode",
        kind: "media",
        recovered: true,
      }),
    ).toEqual({ action: "give-up" });
  });

  it("converts straight away with native HLS (nothing to recover)", () => {
    expect(
      nextFallback({
        ...base,
        mode: "remux",
        kind: "media",
        usingHlsJs: false,
      }),
    ).toEqual({ action: "restart", forceMode: "transcode" });
  });

  it("retries network trouble once in the same mode", () => {
    expect(
      nextFallback({
        ...base,
        mode: "remux",
        kind: "network",
        forceMode: "remux",
      }),
    ).toEqual({ action: "restart", forceMode: "remux" });
    expect(
      nextFallback({
        ...base,
        mode: "remux",
        kind: "network",
        networkRestarts: 1,
      }),
    ).toEqual({ action: "give-up" });
  });
});
