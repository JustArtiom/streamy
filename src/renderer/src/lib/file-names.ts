/**
 * A file name people can read: no extension, and dots or underscores used
 * as spaces become spaces ("Big.Buck.Bunny.mkv" → "Big Buck Bunny").
 */
export function readableName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, "");
  return base.includes(" ") ? base : base.replace(/[._]+/g, " ").trim();
}
