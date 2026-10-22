import { describe, expect, it } from "vitest";
import { naturalCompare, naturalSortBy } from "@/lib/natural-sort";

describe("natural sort", () => {
  it("orders numbers by value", () => {
    expect(naturalCompare("Episode 2", "Episode 10")).toBeLessThan(0);
    expect(
      ["S01E10.mkv", "S01E02.mkv", "S01E01.mkv"].sort(naturalCompare),
    ).toEqual(["S01E01.mkv", "S01E02.mkv", "S01E10.mkv"]);
  });

  it("ignores case", () => {
    expect(naturalCompare("alpha", "Alpha")).toBe(0);
  });

  it("sorts by a key without changing the input", () => {
    const files = [{ path: "b/ep10" }, { path: "a/ep2" }, { path: "b/ep9" }];
    const sorted = naturalSortBy(files, (file) => file.path);
    expect(sorted.map((file) => file.path)).toEqual([
      "a/ep2",
      "b/ep9",
      "b/ep10",
    ]);
    expect(files[0]?.path).toBe("b/ep10");
  });
});
