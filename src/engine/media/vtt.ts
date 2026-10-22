import type { Cue } from "../../shared/engine-api";

/*
 * A small WebVTT parser for what ffmpeg's webvtt encoder writes (from SRT,
 * ASS, mov_text, …). The text comes from strangers' torrents, so only plain
 * text plus <i>, <b>, <u> survives; the frontend renders it without HTML.
 */

// "01:02:03.456" or "02:03.456" (hours optional), at the start of a line.
const TIMING =
  /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function seconds(
  hours: string | undefined,
  minutes: string,
  secs: string,
  millis: string,
): number {
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(secs) +
    Number(millis.padEnd(3, "0")) / 1000
  );
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": "\u00a0",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lrm;": "",
  "&rlm;": "",
};

/** Keeps <i> <b> <u> (without attributes or classes), drops other tags and ASS leftovers. */
export function cleanCueText(text: string): string {
  return (
    text
      // ASS override blocks that survived the conversion: {\an8}, {\i1}…
      .replace(/\{\\[^}]*\}/g, "")
      // ASS hard line breaks and spaces.
      .replace(/\\N/gi, "\n")
      .replace(/\\h/g, " ")
      .replace(/<\/?([a-z0-9]+)(?:[.\s][^>]*)?>/gi, (tag, name: string) => {
        const lower = name.toLowerCase();
        if (lower !== "i" && lower !== "b" && lower !== "u") return "";
        return tag.startsWith("</") ? `</${lower}>` : `<${lower}>`;
      })
      .replace(/&(?:amp|lt|gt|nbsp|quot|#39|apos|lrm|rlm);/g, (entity) => {
        return ENTITIES[entity] ?? entity;
      })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
  );
}

/**
 * WebVTT text → cues, sorted by start. A last block without its closing
 * blank line may still be being written, so it's skipped unless `complete`.
 */
export function parseVtt(text: string, options: { complete?: boolean } = {}) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const cues: Cue[] = [];

  let i = 0;
  while (i < lines.length) {
    const match = TIMING.exec(lines[i]?.trim() ?? "");
    if (!match) {
      i++;
      continue;
    }

    const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = match;
    const start = seconds(h1, m1 ?? "0", s1 ?? "0", ms1 ?? "0");
    const end = seconds(h2, m2 ?? "0", s2 ?? "0", ms2 ?? "0");

    const body: string[] = [];
    i++;
    while (i < lines.length && lines[i]?.trim() !== "") {
      body.push(lines[i] ?? "");
      i++;
    }
    // A cue ends with a blank line ("\n\n"). The last "" from split() is only
    // the file's final "\n", so it doesn't count.
    const finished = i < lines.length - 1 || options.complete === true;
    if (!finished) break;

    const cueText = cleanCueText(body.join("\n"));
    if (cueText && end > start) cues.push({ start, end, text: cueText });
  }

  return cues.sort((a, b) => a.start - b.start);
}

/** Cues that overlap [from, to]. A cue ending exactly at `from` is already gone. */
export function cuesBetween(cues: Cue[], from: number, to: number): Cue[] {
  return cues.filter((cue) => cue.end > from && cue.start <= to);
}
