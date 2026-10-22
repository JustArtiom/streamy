/*
 * Reading the HLS playlist ffmpeg writes, to know how much of the movie a
 * session has produced so far, and serving it for blocking reloads.
 */

export type PlaylistSummary = {
  /** Number of segments listed. */
  segments: number;
  /** Σ #EXTINF: seconds of media listed. */
  duration: number;
  /** #EXT-X-ENDLIST: ffmpeg reached the end. */
  ended: boolean;
  /** #EXT-X-MEDIA-SEQUENCE: the number of the first segment listed. */
  mediaSequence: number;
  /** #EXT-X-TARGETDURATION in seconds, null when missing. */
  targetDuration: number | null;
};

function tagValue(line: string, tag: string): number | null {
  if (!line.startsWith(tag)) return null;
  const value = Number.parseFloat(line.slice(tag.length));
  return Number.isFinite(value) ? value : null;
}

export function parsePlaylist(text: string): PlaylistSummary {
  const summary: PlaylistSummary = {
    segments: 0,
    duration: 0,
    ended: false,
    mediaSequence: 0,
    targetDuration: null,
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const extinf = tagValue(line, "#EXTINF:");
    if (extinf !== null && extinf > 0) {
      summary.segments++;
      summary.duration += extinf;
    } else if (line === "#EXT-X-ENDLIST") {
      summary.ended = true;
    } else {
      summary.mediaSequence =
        tagValue(line, "#EXT-X-MEDIA-SEQUENCE:") ?? summary.mediaSequence;
      summary.targetDuration =
        tagValue(line, "#EXT-X-TARGETDURATION:") ?? summary.targetDuration;
    }
  }

  return summary;
}

/** The movie time this session has produced up to: offset + Σ #EXTINF. */
export function producedUntil(offset: number, playlist: PlaylistSummary) {
  return Math.round((offset + playlist.duration) * 1000) / 1000;
}

/** Is segment number `msn` (media sequence number) listed? */
export function hasSegment(playlist: PlaylistSummary, msn: number) {
  return playlist.mediaSequence + playlist.segments > msn;
}

/**
 * How long a blocking reload may be held: 3 target durations (what the
 * HLS spec allows), at most 12 s. 10 s when the playlist doesn't say.
 */
export function blockingReloadLimitMs(playlist: PlaylistSummary | null) {
  const target = playlist?.targetDuration ?? 10;
  return Math.min(3 * target, 12) * 1000;
}

export const SERVER_CONTROL_TAG = "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES";

/**
 * Tells the player it may ask for the next segment right away
 * (`?_HLS_msn=N`) and we'll answer as soon as it exists: without it, hls.js
 * re-reads a growing playlist only once per target duration (up to 10 s of
 * frozen video after every new session). Not once the playlist has ended.
 * The rest of the text stays exactly as ffmpeg wrote it.
 */
export function withBlockingReload(text: string): string {
  if (/^#EXT-X-ENDLIST\s*$/m.test(text) || text.includes(SERVER_CONTROL_TAG)) {
    return text;
  }
  return text.replace(
    /^(#EXT-X-TARGETDURATION:[^\r\n]*)(\r?\n)/m,
    `$1$2${SERVER_CONTROL_TAG}$2`,
  );
}
