import type { HlsConfig, LoadPolicy } from "hls.js";

/**
 * Retries that suit a torrent-backed stream: a segment or playlist can be slow
 * because pieces are still arriving, which is not a reason to give up.
 */
function policy(
  timeToFirstByteMs: number,
  loadMs: number,
  retries: number,
): LoadPolicy {
  return {
    default: {
      maxTimeToFirstByteMs: timeToFirstByteMs,
      maxLoadTimeMs: loadMs,
      timeoutRetry: {
        maxNumRetry: retries,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
      errorRetry: {
        maxNumRetry: retries,
        retryDelayMs: 1000,
        maxRetryDelayMs: 8000,
        backoff: "exponential",
      },
    },
  };
}

/**
 * `startPosition` is in SESSION time: a session that ffmpeg started at movie
 * time `offset` plays movie time `start` at `start - offset`.
 */
export function hlsConfig(startPosition: number): Partial<HlsConfig> {
  return {
    startPosition,
    maxBufferLength: 60,
    backBufferLength: 90,
    // Our playlists grow while ffmpeg works. The engine supports blocking
    // reloads (CAN-BLOCK-RELOAD): with lowLatencyMode hls.js asks for "the
    // playlist once segment N exists" and gets it the moment it's written.
    // Without it, hls.js re-reads only once per target duration (up to ~10 s)
    // and playback stalls right after every new session. It never jumps to
    // the live edge here: startPosition is always set.
    lowLatencyMode: true,
    manifestLoadPolicy: policy(20_000, 30_000, 4),
    playlistLoadPolicy: policy(20_000, 30_000, 6),
    fragLoadPolicy: policy(30_000, 120_000, 6),
  };
}
