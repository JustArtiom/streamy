import type { ClientCapabilities } from "../../../shared/engine-api";

/**
 * The exact type strings the engine's mode decision depends on
 * (prototype_plan.md §6.3).
 */
export const TYPES = {
  h264: 'video/mp4; codecs="avc1.640028"',
  h264High10: 'video/mp4; codecs="avc1.6e0028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  hevcMain10: 'video/mp4; codecs="hvc1.2.4.L120.90"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  vp9: 'video/mp4; codecs="vp09.00.40.08"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mp4; codecs="mp4a.69"',
  mp3Plain: "audio/mpeg",
  opus: 'audio/mp4; codecs="opus"',
  flac: 'audio/mp4; codecs="flac"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  directMp4: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  directWebm: 'video/webm; codecs="vp9, opus"',
} as const;

export type CapabilityChecks = {
  /** MediaSource.isTypeSupported, or null when there's no MediaSource at all. */
  isTypeSupported: ((type: string) => boolean) | null;
  /** HTMLVideoElement.canPlayType: "", "maybe" or "probably". */
  canPlayType: (type: string) => string;
};

/**
 * What this Chromium can decode. hls.js feeds MediaSource, so its answers are
 * the ones that count. Without MediaSource (some iPhones) the native player is
 * the only way, so canPlayType answers instead.
 */
export function detectCapabilities(
  checks: CapabilityChecks,
): ClientCapabilities {
  const { isTypeSupported, canPlayType } = checks;
  const native = (type: string) => safe(() => canPlayType(type) !== "");
  const supports = (type: string) =>
    isTypeSupported ? safe(() => isTypeSupported(type)) : native(type);

  return {
    video: {
      h264: supports(TYPES.h264),
      h264High10: supports(TYPES.h264High10),
      hevc: supports(TYPES.hevc),
      hevcMain10: supports(TYPES.hevcMain10),
      av1: supports(TYPES.av1),
      vp9: supports(TYPES.vp9),
    },
    audio: {
      aac: supports(TYPES.aac),
      mp3: supports(TYPES.mp3) || supports(TYPES.mp3Plain),
      opus: supports(TYPES.opus),
      flac: supports(TYPES.flac),
      ac3: supports(TYPES.ac3),
      eac3: supports(TYPES.eac3),
    },
    direct: {
      mp4: native(TYPES.directMp4),
      webm: native(TYPES.directWebm),
    },
  };
}

function safe(check: () => boolean) {
  try {
    return check();
  } catch {
    return false;
  }
}

type MediaSourceLike = { isTypeSupported: (type: string) => boolean };

/** The real checks of this browser. */
export function browserChecks(): CapabilityChecks {
  const scope = window as unknown as {
    MediaSource?: MediaSourceLike;
    ManagedMediaSource?: MediaSourceLike;
  };
  // ManagedMediaSource = Safari on iPhone (iOS 17.1+); hls.js uses it too.
  const source = scope.MediaSource ?? scope.ManagedMediaSource;
  const video = document.createElement("video");
  return {
    isTypeSupported: source ? (type) => source.isTypeSupported(type) : null,
    canPlayType: (type) => video.canPlayType(type),
  };
}

let cached: ClientCapabilities | null = null;

/** Measured once per page load: the answers don't change. */
export function browserCapabilities() {
  cached ??= detectCapabilities(browserChecks());
  return cached;
}
