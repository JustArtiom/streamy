/**
 * What to answer to a `Range` header for a file of `size` bytes:
 *   none           → 200 with the whole file
 *   unsatisfiable  → 416 Range Not Satisfiable
 *   range          → 206 with bytes [start, end] (inclusive)
 */
export type RangeResult =
  | { type: "none" }
  | { type: "unsatisfiable" }
  | { type: "range"; start: number; end: number };

const NONE: RangeResult = { type: "none" };
const UNSATISFIABLE: RangeResult = { type: "unsatisfiable" };

/**
 * Parses a single byte range (RFC 9110): `bytes=a-b`, `bytes=a-`, `bytes=-n`.
 * Several ranges at once are rare for video and need a multipart body, so
 * they are ignored and the whole file is sent. So is an unknown unit.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): RangeResult {
  if (!header) return NONE;

  const [unit, spec] = header.split("=", 2).map((part) => part.trim());
  if (unit?.toLowerCase() !== "bytes" || spec === undefined) return NONE;
  if (spec.includes(",")) return NONE;

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return UNSATISFIABLE;
  const [, first = "", last = ""] = match;

  // Suffix range: the last n bytes (players read an MP4's index this way).
  if (first === "") {
    const length = Number(last);
    if (last === "" || length === 0 || size === 0) return UNSATISFIABLE;
    return { type: "range", start: Math.max(size - length, 0), end: size - 1 };
  }

  const start = Number(first);
  // An end past the file is fine: it's clamped to the last byte.
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || (last !== "" && Number(last) < start)) {
    return UNSATISFIABLE;
  }
  return { type: "range", start, end };
}
