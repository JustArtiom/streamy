import { describe, expect, it } from "vitest";
import { cleanCueText, cuesBetween, parseVtt } from "./vtt";

describe("parseVtt", () => {
  it("reads HH:MM:SS.mmm and MM:SS.mmm timings", () => {
    const cues = parseVtt(
      "WEBVTT\n\n00:20.500 --> 00:22.000\nHello\n\n01:02:03.004 --> 01:02:05.000\nLater\n\n",
    );
    expect(cues).toEqual([
      { start: 20.5, end: 22, text: "Hello" },
      { start: 3723.004, end: 3725, text: "Later" },
    ]);
  });

  it("ignores cue settings and cue ids, joins lines with \\n", () => {
    const cues = parseVtt(
      "WEBVTT\n\nintro\n00:01.000 --> 00:02.000 align:start position:10%\nLine one\nLine two\n\n",
    );
    expect(cues).toEqual([{ start: 1, end: 2, text: "Line one\nLine two" }]);
  });

  it("handles a BOM and CRLF line endings", () => {
    const cues = parseVtt(
      "﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHi\r\n\r\n",
    );
    expect(cues).toEqual([{ start: 1, end: 2, text: "Hi" }]);
  });

  it("skips a half-written last block", () => {
    const text =
      "WEBVTT\n\n00:01.000 --> 00:02.000\nDone\n\n00:03.000 --> 00:04.000\nStill wri";
    expect(parseVtt(text)).toEqual([{ start: 1, end: 2, text: "Done" }]);
    expect(parseVtt(`${text}ting\n`)).toHaveLength(1);
    expect(parseVtt(`${text}ting\n\n`)).toHaveLength(2);
  });

  it("keeps the last block when the file is complete", () => {
    const text = "WEBVTT\n\n00:01.000 --> 00:02.000\nLast";
    expect(parseVtt(text, { complete: true })).toEqual([
      { start: 1, end: 2, text: "Last" },
    ]);
  });

  it("drops empty and backwards cues, sorts by start", () => {
    const cues = parseVtt(
      "WEBVTT\n\n00:05.000 --> 00:06.000\nB\n\n00:01.000 --> 00:02.000\nA\n\n00:03.000 --> 00:02.000\nBad\n\n00:04.000 --> 00:05.000\n{\\an8}\n\n",
    );
    expect(cues.map((c) => c.text)).toEqual(["A", "B"]);
  });
});

describe("cleanCueText", () => {
  it("keeps only <i>, <b>, <u> without attributes", () => {
    expect(
      cleanCueText(
        '<i>a</i> <b.loud>b</b> <u>c</u> <c.yellow>d</c> <font color="red">e</font> <script>x</script>',
      ),
    ).toBe("<i>a</i> <b>b</b> <u>c</u> d e x");
  });

  it("strips ASS leftovers and decodes entities", () => {
    expect(cleanCueText("{\\an8}Top &amp; &lt;3 &gt; &quot;q&quot;")).toBe(
      'Top & <3 > "q"',
    );
    expect(cleanCueText("One\\NTwo")).toBe("One\nTwo");
  });

  it("decodes once (no double decoding of &amp;lt;)", () => {
    expect(cleanCueText("&amp;lt;")).toBe("&lt;");
  });
});

describe("cuesBetween", () => {
  const cues = [
    { start: 1, end: 2, text: "a" },
    { start: 5, end: 8, text: "b" },
    { start: 10, end: 11, text: "c" },
  ];

  it("returns cues overlapping the range", () => {
    expect(cuesBetween(cues, 6, 9).map((c) => c.text)).toEqual(["b"]);
    expect(cuesBetween(cues, 0, 100)).toHaveLength(3);
    expect(cuesBetween(cues, 2.5, 4)).toEqual([]);
    expect(cuesBetween(cues, 2, 4)).toEqual([]);
    expect(cuesBetween(cues, 0, 1).map((c) => c.text)).toEqual(["a"]);
  });
});
