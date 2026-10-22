import type { Cue } from "../../../../shared/engine-api";

/**
 * Cues on screen at `time`. A positive delay shows subtitles later (like
 * VLC and mpv): "+0.5 s" fixes subtitles that come too early.
 */
export function activeCues(cues: readonly Cue[], time: number, delay = 0) {
  const t = time - delay;
  return cues.filter((cue) => cue.start <= t && t < cue.end);
}

/**
 * Adds newly fetched cues to the ones we have. Embedded cues arrive in
 * overlapping windows, so the same cue shows up again and again; start+text
 * identifies it. Sorted by start, like the engine sends them.
 */
export function mergeCues(current: readonly Cue[], incoming: readonly Cue[]) {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map(cueKey));
  const added = incoming.filter((cue) => !seen.has(cueKey(cue)));
  if (added.length === 0) return current;
  return [...current, ...added].sort((a, b) => a.start - b.start);
}

export function cueKey(cue: Cue) {
  return `${cue.start.toFixed(3)}|${cue.text}`;
}

// ─── Safe formatting ─────────────────────────────────────────────────────────

export type CueTag = "i" | "b" | "u";

export type CueNode =
  | { type: "text"; text: string }
  | { type: "br" }
  | { type: "tag"; tag: CueTag; children: CueNode[] };

const TAG = /<(\/?)([ibu])>/gi;

/**
 * Subtitle text comes from strangers' torrents, so it is never handed to the
 * browser as HTML. This reads only <i>, <b>, <u> and line breaks into a small
 * tree; anything else ("<font>", "<3", "a < b") stays visible as plain text.
 * Unbalanced tags are forgiven: a stray closing tag is dropped, an unclosed
 * one ends with the cue.
 */
export function parseCueText(text: string): CueNode[] {
  const root: CueNode[] = [];
  const stack: { tag: CueTag; children: CueNode[] }[] = [];
  const current = () => stack.at(-1)?.children ?? root;

  const pushText = (value: string) => {
    const lines = value.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (i > 0) current().push({ type: "br" });
      if (line) current().push({ type: "text", text: line });
    });
  };

  let last = 0;
  for (const match of text.matchAll(TAG)) {
    pushText(text.slice(last, match.index));
    last = match.index + match[0].length;

    const closing = match[1] === "/";
    const tag = (match[2] ?? "i").toLowerCase() as CueTag;

    if (!closing) {
      const node: CueNode = { type: "tag", tag, children: [] };
      current().push(node);
      stack.push(node);
      continue;
    }

    // Close up to (and including) the matching open tag; ignore strays.
    const at = stack.map((open) => open.tag).lastIndexOf(tag);
    if (at !== -1) stack.length = at;
  }
  pushText(text.slice(last));

  return root;
}
