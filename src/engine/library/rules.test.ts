import { describe, expect, it } from "vitest";
import { decideWatched, isWatchedByRule } from "./rules";

describe("isWatchedByRule", () => {
  it.each([
    // [position, duration, watched, why]
    [6839, 7200, false, "a 2 h film just before 95%"],
    [6840, 7200, true, "a 2 h film at 95% (6 min before the end)"],
    [1079, 1200, false, "a 20 min episode just over 2 min before the end"],
    [1080, 1200, true, "a 20 min episode 2 min before the end"],
    [480, 600, true, "a 10 min file 2 min before the end (also 80%)"],
    [143, 180, false, "a 3 min clip: 2 min before the end isn't enough"],
    [144, 180, true, "a 3 min clip at 80%"],
    [0, 60, false, "a 1 min clip that just opened"],
    [48, 60, true, "a 1 min clip at 80%"],
    [7300, 7200, true, "past the end (rounding)"],
  ])("%s s of %s s → %s (%s)", (position, duration, watched) => {
    expect(isWatchedByRule(position, duration)).toBe(watched);
  });

  it("needs a known duration", () => {
    expect(isWatchedByRule(7000, null)).toBe(false);
    expect(isWatchedByRule(0, 0)).toBe(false);
    expect(isWatchedByRule(10, 0)).toBe(false);
  });
});

describe("decideWatched", () => {
  it("follows the rule for a file not watched before", () => {
    expect(
      decideWatched({ position: 6840, duration: 7200, wasWatched: false }),
    ).toBe(true);
    expect(
      decideWatched({ position: 600, duration: 7200, wasWatched: false }),
    ).toBe(false);
  });

  it("keeps a finished file watched while it's only opened or restarted", () => {
    expect(
      decideWatched({ position: 0, duration: 7200, wasWatched: true }),
    ).toBe(true);
    expect(
      decideWatched({ position: 30, duration: 7200, wasWatched: true }),
    ).toBe(true);
  });

  it("un-watches a finished file once it's really being watched again", () => {
    expect(
      decideWatched({ position: 30.5, duration: 7200, wasWatched: true }),
    ).toBe(false);
  });

  it("keeps it watched near the end again", () => {
    expect(
      decideWatched({ position: 7100, duration: 7200, wasWatched: true }),
    ).toBe(true);
  });
});
