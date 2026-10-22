import { describe, expect, it } from "vitest";
import { parseRange } from "./range";

describe("parseRange", () => {
  it("returns none without a header", () => {
    expect(parseRange(undefined, 100)).toEqual({ type: "none" });
    expect(parseRange("", 100)).toEqual({ type: "none" });
  });

  it.each([
    ["bytes=0-9", 0, 9],
    ["bytes=10-19", 10, 19],
    ["bytes=0-0", 0, 0],
    ["bytes=99-99", 99, 99],
    ["bytes=50-", 50, 99],
    ["bytes=0-", 0, 99],
    ["bytes=-10", 90, 99],
    ["bytes=-1", 99, 99],
    ["Bytes = 5-6", 5, 6],
  ])("%s → bytes %i-%i", (header, start, end) => {
    expect(parseRange(header, 100)).toEqual({ type: "range", start, end });
  });

  it("clamps an end past the file to the last byte", () => {
    expect(parseRange("bytes=90-500", 100)).toEqual({
      type: "range",
      start: 90,
      end: 99,
    });
  });

  it("gives the whole file for a suffix longer than the file", () => {
    expect(parseRange("bytes=-500", 100)).toEqual({
      type: "range",
      start: 0,
      end: 99,
    });
  });

  it.each([
    "bytes=100-",
    "bytes=100-200",
    "bytes=500-",
    "bytes=-0",
    "bytes=20-10",
    "bytes=-",
    "bytes=abc",
    "bytes=1-2-3",
    "bytes=",
  ])("%s is unsatisfiable", (header) => {
    expect(parseRange(header, 100)).toEqual({ type: "unsatisfiable" });
  });

  it("can't satisfy any range of an empty file", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ type: "unsatisfiable" });
    expect(parseRange("bytes=-5", 0)).toEqual({ type: "unsatisfiable" });
  });

  it("ignores several ranges at once (sends the whole file)", () => {
    expect(parseRange("bytes=0-9,20-29", 100)).toEqual({ type: "none" });
  });

  it("ignores unknown units", () => {
    expect(parseRange("items=0-9", 100)).toEqual({ type: "none" });
    expect(parseRange("nonsense", 100)).toEqual({ type: "none" });
  });
});
