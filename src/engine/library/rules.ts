// The library's rules from the API contract (src/shared/engine-api.ts,
// "Library"): when a file counts as watched, and what the lists show.

/** Recent shows this many torrents at most. */
export const RECENT_LIMIT = 50;
/** Continue watching shows this many files at most. */
export const CONTINUE_WATCHING_LIMIT = 20;
/** Positions up to this many seconds aren't shown in Continue watching. */
export const CONTINUE_WATCHING_MIN_POSITION = 30;

/** Watched once this close to the end (seconds): the credits. */
export const WATCHED_END_SECONDS = 120;
/** Watched once this far in. */
export const WATCHED_FRACTION = 0.95;
/**
 * The "close to the end" rule only counts once this far in. Without it, any
 * clip shorter than 2 minutes would be "watched" the moment it opens. It only
 * changes anything for files under 10 minutes (2 min = 20% of 10 min).
 */
export const END_RULE_MIN_FRACTION = 0.8;

/**
 * The watched rule: within 2 minutes of the end (and 80% in), or past 95%.
 * Needs a known duration: without one, nothing is "near the end".
 */
export function isWatchedByRule(
  position: number,
  duration: number | null,
): boolean {
  if (duration === null || duration <= 0) return false;
  if (position >= duration * WATCHED_FRACTION) return true;
  return (
    duration - position <= WATCHED_END_SECONDS &&
    position >= duration * END_RULE_MIN_FRACTION
  );
}

interface WatchedInput {
  position: number;
  duration: number | null;
  /** What's saved for this file now (false when nothing is). */
  wasWatched: boolean;
}

/**
 * Whether a file is watched after a save that didn't say so explicitly.
 *
 * The rule can un-watch a file, but only once the viewer is past the first
 * 30 s again: re-watching a finished film for real brings it back to
 * Continue watching (where it then belongs), while just opening it, or
 * "start over" followed by closing the player, keeps it watched.
 */
export function decideWatched({
  position,
  duration,
  wasWatched,
}: WatchedInput): boolean {
  if (isWatchedByRule(position, duration)) return true;
  return wasWatched && position <= CONTINUE_WATCHING_MIN_POSITION;
}
