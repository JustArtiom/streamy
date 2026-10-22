import type { PlaybackMode } from "../../../../shared/engine-api";

/**
 * The player keeps ONE timeline, the movie's. An HLS session that ffmpeg
 * started at 20 s plays its first frame at video.currentTime 0, so:
 *
 *   movie time = session offset + video.currentTime
 */
export function movieTime(offset: number, currentTime: number) {
  return offset + (Number.isFinite(currentTime) ? currentTime : 0);
}

/** Seeking to the very end would stall waiting for frames that never come. */
export function clampSeekTarget(target: number, duration: number) {
  const max = Math.max(0, duration - 0.5);
  if (!Number.isFinite(target)) return 0;
  return Math.min(max, Math.max(0, target));
}

export type SeekDecision =
  /** Seek inside what the current session can play. */
  | { kind: "local"; currentTime: number }
  /** Outside it: a new ffmpeg run starting at `start`. */
  | { kind: "session"; start: number };

export function decideSeek(input: {
  target: number;
  duration: number;
  mode: PlaybackMode;
  offset: number;
  /**
   * Movie time the player can seek to in this session; null when unknown.
   * With hls.js that's the end of the playlist it has loaded, not what the
   * engine says it produced: past its playlist hls.js treats the stream as
   * live and jumps back to its edge.
   */
  seekableUntil: number | null;
}): SeekDecision {
  const t = clampSeekTarget(input.target, input.duration);

  // The browser reads the file itself with Range requests: any time works.
  if (input.mode === "direct") return { kind: "local", currentTime: t };

  // Stay a second away from the edge: landing in the last segment just
  // means waiting for ffmpeg's next one.
  const { offset, seekableUntil } = input;
  if (seekableUntil !== null && t >= offset && t <= seekableUntil - 1) {
    return { kind: "local", currentTime: t - offset };
  }
  return { kind: "session", start: t };
}

/**
 * How far this session has got. The heartbeat answer and hls.js's playlist
 * total both say it; whichever is further is the truth (one lags the other).
 */
export function mergeProducedUntil(...values: (number | null | undefined)[]) {
  let best: number | null = null;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      best = best === null ? value : Math.max(best, value);
    }
  }
  return best;
}

export type TimeRange = { start: number; end: number };

/** video.buffered (session time) → movie time. */
export function toMovieRanges(
  ranges: Pick<TimeRanges, "length" | "start" | "end">,
  offset: number,
): TimeRange[] {
  const result: TimeRange[] = [];
  for (let i = 0; i < ranges.length; i++) {
    result.push({
      start: offset + ranges.start(i),
      end: offset + ranges.end(i),
    });
  }
  return result;
}

/** Seconds of video ready to play after `time` (0 when not inside a range). */
export function bufferedAhead(ranges: TimeRange[], time: number) {
  // Small gaps between ranges are normal at segment edges; treat 0.5 s as touching.
  const range = ranges.find((r) => time >= r.start - 0.5 && time <= r.end);
  return range ? Math.max(0, range.end - time) : 0;
}

export function sameRanges(a: TimeRange[], b: TimeRange[]) {
  return (
    a.length === b.length &&
    a.every(
      (range, i) =>
        Math.abs(range.start - (b[i]?.start ?? NaN)) < 0.25 &&
        Math.abs(range.end - (b[i]?.end ?? NaN)) < 0.25,
    )
  );
}

export type FailureKind = "media" | "network";

export type FallbackStep =
  /** hls.js can often get past a decode hiccup by itself. */
  | { action: "recover" }
  /** Start a new session at the current time. */
  | { action: "restart"; forceMode: PlaybackMode | null }
  | { action: "give-up" };

/**
 * What to do when playback breaks:
 *   direct can't decode → remux; remux can't → recoverMediaError once, then
 *   transcode; transcode can't → give up (error overlay with Retry).
 * Network trouble isn't a format problem, so it gets one fresh session in the
 * same mode before giving up.
 */
export function nextFallback(input: {
  mode: PlaybackMode;
  kind: FailureKind;
  /** The mode the current session was forced into, if any. */
  forceMode: PlaybackMode | null;
  /** recoverMediaError() was already tried for this session. */
  recovered: boolean;
  /** hls.js is playing it (recoverMediaError exists). */
  usingHlsJs: boolean;
  /** Fresh sessions already started for network trouble since it last played. */
  networkRestarts: number;
  /** The engine can't convert (no working ffmpeg): nothing to fall back to. */
  canConvert: boolean;
}): FallbackStep {
  if (input.kind === "network") {
    return input.networkRestarts < 1
      ? { action: "restart", forceMode: input.forceMode }
      : { action: "give-up" };
  }

  if (input.mode === "direct") {
    return input.canConvert
      ? { action: "restart", forceMode: "remux" }
      : { action: "give-up" };
  }

  if (input.usingHlsJs && !input.recovered) return { action: "recover" };
  if (input.mode === "remux")
    return { action: "restart", forceMode: "transcode" };
  return { action: "give-up" };
}
