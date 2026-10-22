import type { FileProgress } from "../../../shared/engine-api";

/**
 * Positions under this aren't worth resuming (the library's own rule: they
 * don't show in Continue watching either).
 */
export const MIN_RESUME_SECONDS = 30;

/** Where to resume a file, or null to start from the beginning. */
export function resumePosition(
  progress: Pick<FileProgress, "position" | "watched"> | null | undefined,
): number | null {
  if (!progress || progress.watched) return null;
  return progress.position >= MIN_RESUME_SECONDS ? progress.position : null;
}
