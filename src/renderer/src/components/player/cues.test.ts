import { describe, expect, it } from "vitest";
import { activeCues, mergeCues, parseCueText } from "@/components/player/cues";

const cues = [
  { start: 1, end: 3, text: "one" },
  { start: 2.5, end: 4, text: "two" },
  { start: 10, end: 12, text: "three" },
];

describe("activeCues", () => {
  it("shows cues where start <= time < end", () => {
    expect(activeCues(cues, 1).map((c) => c.text)).toEqual(["one"]);
    expect(activeCues(cues, 2.7).map((c) => c.text)).toEqual(["one", "two"]);
    expect(activeCues(cues, 3).map((c) => c.text)).toEqual(["two"]);
    expect(activeCues(cues, 5)).toEqual([]);
  });

  it("shows subtitles later with a positive delay", () => {
    // +2 s: the cue at 10 s now appears at 12 s.
    expect(activeCues(cues, 11, 2)).toEqual([]);
    expect(activeCues(cues, 12, 2).map((c) => c.text)).toEqual(["three"]);
  });

  it("shows subtitles earlier with a negative delay", () => {
    expect(activeCues(cues, 9, -1).map((c) => c.text)).toEqual(["three"]);
  });
});

describe("mergeCues", () => {
  it("adds new cues, drops ones we already have, keeps them sorted", () => {
    const merged = mergeCues(cues, [
      { start: 10, end: 12, text: "three" },
      { start: 5, end: 6, text: "new" },
    ]);
    expect(merged.map((c) => c.text)).toEqual(["one", "two", "new", "three"]);
  });

  it("returns the same array when nothing is new (no re-render)", () => {
    expect(mergeCues(cues, cues.slice(0, 1))).toBe(cues);
    expect(mergeCues(cues, [])).toBe(cues);
  });

  it("keeps different lines that start at the same time", () => {
    const merged = mergeCues(cues, [{ start: 1, end: 3, text: "other" }]);
    expect(merged).toHaveLength(4);
  });
});

describe("parseCueText", () => {
  it("splits lines", () => {
    expect(parseCueText("Hello\nworld")).toEqual([
      { type: "text", text: "Hello" },
      { type: "br" },
      { type: "text", text: "world" },
    ]);
  });

  it("reads <i>, <b> and <u>, nested", () => {
    expect(parseCueText("a <i>b <b>c</b></i> <U>d</U>")).toEqual([
      { type: "text", text: "a " },
      {
        type: "tag",
        tag: "i",
        children: [
          { type: "text", text: "b " },
          { type: "tag", tag: "b", children: [{ type: "text", text: "c" }] },
        ],
      },
      { type: "text", text: " " },
      { type: "tag", tag: "u", children: [{ type: "text", text: "d" }] },
    ]);
  });

  it("keeps any other markup as visible text", () => {
    expect(parseCueText('<font color="red">hi</font>')).toEqual([
      { type: "text", text: '<font color="red">hi</font>' },
    ]);
    expect(parseCueText("<script>alert(1)</script>")).toEqual([
      { type: "text", text: "<script>alert(1)</script>" },
    ]);
    expect(parseCueText("I <3 you & a < b")).toEqual([
      { type: "text", text: "I <3 you & a < b" },
    ]);
  });

  it("forgives unbalanced tags", () => {
    // stray closing tag: dropped
    expect(parseCueText("a</i>b")).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    // unclosed: ends with the cue
    expect(parseCueText("<i>a")).toEqual([
      { type: "tag", tag: "i", children: [{ type: "text", text: "a" }] },
    ]);
    // crossed: closing <i> also closes the <b> inside it
    expect(parseCueText("<i><b>x</i>y</b>")).toEqual([
      {
        type: "tag",
        tag: "i",
        children: [
          { type: "tag", tag: "b", children: [{ type: "text", text: "x" }] },
        ],
      },
      { type: "text", text: "y" },
    ]);
  });

  it("keeps line breaks inside tags", () => {
    expect(parseCueText("<i>one\ntwo</i>")).toEqual([
      {
        type: "tag",
        tag: "i",
        children: [
          { type: "text", text: "one" },
          { type: "br" },
          { type: "text", text: "two" },
        ],
      },
    ]);
  });
});
