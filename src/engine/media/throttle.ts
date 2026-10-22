/*
 * ffmpeg runs much faster than real time: with the file already on disk, a
 * remux would copy a whole movie into playback/ in seconds. Far ahead of
 * the viewer that only fills the disk and burns CPU, so a session's input
 * (its token URL) holds its bytes back instead, and ffmpeg simply waits in
 * read() until the viewer gets closer. That works the same on every OS
 * (Windows can't pause a process), and only ever touches the session's own
 * input: probes, thumbnails and direct play read with other URLs.
 *
 * Checked every second: hold/release by how far ahead the produced
 * segments are, and between checks a byte allowance so a fast disk can't
 * run away in the meantime.
 */

export type ThrottleAction = "hold" | "release" | null;

/**
 * Hold the input back when more than `aheadSeconds` are produced beyond
 * the viewer's position; let it go again once that drops below
 * `aheadSeconds - margin`. The margin (60 s, or half for small values)
 * stops it flapping every second.
 */
export function throttleAction(options: {
  held: boolean;
  producedUntil: number;
  position: number;
  aheadSeconds: number;
}): ThrottleAction {
  const ahead = options.producedUntil - options.position;
  const margin = Math.min(60, options.aheadSeconds / 2);

  if (!options.held && ahead > options.aheadSeconds) return "hold";
  if (options.held && ahead < options.aheadSeconds - margin) return "release";
  return null;
}

/** Never less than this per grant: keeps ffmpeg moving when the estimate is low. */
export const MIN_ALLOWANCE_BYTES = 1024 * 1024;

/**
 * How many more bytes the input may pass until the next check: about what
 * the rest of the lead takes at the file's average bitrate. Without it, a
 * file already on disk would be copied far ahead between two checks (a
 * second is about a gigabyte at disk speed). 0 while held; null = no limit
 * (bitrate unknown: only holding applies).
 */
export function inputAllowance(options: {
  held: boolean;
  /** producedUntil - the viewer's position (s). */
  ahead: number;
  aheadSeconds: number;
  /** The file's average: size / duration. */
  bytesPerSecond: number | null;
}): number | null {
  if (options.held) return 0;
  if (options.bytesPerSecond === null) return null;
  return Math.max(
    MIN_ALLOWANCE_BYTES,
    Math.round((options.aheadSeconds - options.ahead) * options.bytesPerSecond),
  );
}
