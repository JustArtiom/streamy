// A safety net for text that comes from the engine or the main process.
// Both should only send plain sentences for people, but a raw system error
// ("ENOSPC: no space left on device, write", a stack trace, an ffmpeg log
// line) can still slip through. Such text helps nobody on screen: it's in
// the logs already, so show a plain sentence instead.

/** What's shown when the real text is for developers. */
export const SOMETHING_WENT_WRONG = "Something went wrong. Please try again.";

const TECHNICAL: RegExp[] = [
  // Node/libuv error codes: "ENOSPC: no space…", "spawn ffmpeg ENOENT".
  /\bE[A-Z]{2,}:/,
  /\bE(?:NOENT|ACCES|PERM|NOSPC|EXIST|ISDIR|NOTDIR|NOTEMPTY|BUSY|MFILE|NFILE|IO|ROFS|AGAIN|PIPE|ADDRINUSE|ADDRNOTAVAIL|CONNREFUSED|CONNRESET|CONNABORTED|TIMEDOUT|HOSTUNREACH|NETUNREACH|NOTFOUND|INVAL|CANCELED)\b/,
  // JavaScript errors and their usual wording.
  /\b(?:Type|Reference|Syntax|Range|Internal|URI|Eval|Aggregate|System)Error\b/,
  /^\s*Error\b/,
  /Unexpected (?:error|token|end of)/i,
  /Cannot (?:read|set) propert/i,
  /\bis not (?:a function|defined|iterable|a constructor)\b/,
  /\bundefined\b|\bnull\b|\bNaN\b|\[object \w+\]/,
  // Stack frames: "    at foo (file.js:12:3)", "file.js:12:34".
  /^\s*at\s.+/m,
  /\.(?:[cm]?js|ts|tsx|node):\d+(?::\d+)?/,
  // Absolute paths: "/Users/…", "C:\…", "\\server\…".
  /(?:^|[\s"'(=:])\/(?:[\w.@-]+\/)+[\w.@-]*/,
  /(?:^|[\s"'(=])[A-Za-z]:[\\/]/,
  /(?:^|[\s"'(=])\\\\[\w.-]+\\/,
  // ffmpeg log lines: "[h264 @ 0x7f8a1c00]".
  /\[[^\]]*@\s*0x[0-9a-f]+\]/i,
];

/** A wall of text is a log, not a message. */
const MAX_LENGTH = 400;
const MAX_LINES = 4;

/** True when `text` reads like it was written for developers, not people. */
export function looksTechnical(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  if (trimmed.length > MAX_LENGTH) return true;
  if (trimmed.split("\n").length > MAX_LINES) return true;
  return TECHNICAL.some((pattern) => pattern.test(trimmed));
}

/**
 * `text` when it's a sentence for people, else `fallback`. Use it wherever
 * engine or main-process text is shown (errors, statuses). The original is
 * logged once, so it can still be found while debugging.
 */
export function peopleText(
  text: string | null | undefined,
  fallback: string = SOMETHING_WENT_WRONG,
): string {
  if (text == null || looksTechnical(text)) {
    if (text != null) logOnce(text);
    return fallback;
  }
  return text.trim();
}

/** Texts already logged (renders repeat). */
const logged = new Set<string>();

function logOnce(text: string) {
  if (logged.has(text)) return;
  logged.add(text);
  console.warn("Shown as a plain sentence instead:", text);
}
