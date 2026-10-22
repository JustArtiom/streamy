import { describe, expect, it } from "vitest";
import { type EvictionCandidate, planEviction } from "./eviction";

const GB = 1024 ** 3;

/** A torrent of `gb` GB last used on day `day`. */
const torrent = (
  infoHash: string,
  gb: number,
  day: number,
  active = false,
): EvictionCandidate => ({
  infoHash,
  bytes: gb * GB,
  lastUsedAt: Date.UTC(2026, 0, day),
  active,
});

describe("planEviction", () => {
  const torrents = [
    torrent("new", 2, 20),
    torrent("old", 3, 1),
    torrent("middle", 4, 10),
  ];

  it("deletes nothing without a limit", () => {
    expect(planEviction({ torrents, limitBytes: null })).toEqual({
      evict: [],
      usedBytes: 9 * GB,
      usedBytesAfter: 9 * GB,
      stillOverLimit: false,
    });
  });

  it("deletes nothing under the limit, or exactly at it", () => {
    expect(planEviction({ torrents, limitBytes: 10 * GB }).evict).toEqual([]);
    expect(planEviction({ torrents, limitBytes: 9 * GB }).evict).toEqual([]);
  });

  it("deletes the least recently used first, only until it fits", () => {
    expect(planEviction({ torrents, limitBytes: 9 * GB - 1 })).toEqual({
      evict: ["old"],
      usedBytes: 9 * GB,
      usedBytesAfter: 6 * GB,
      stillOverLimit: false,
    });
    expect(planEviction({ torrents, limitBytes: 5 * GB }).evict).toEqual([
      "old",
      "middle",
    ]);
  });

  it("never deletes an active torrent, however old", () => {
    const plan = planEviction({
      torrents: [torrent("playing", 3, 1, true), torrent("stored", 3, 20)],
      limitBytes: 4 * GB,
    });

    expect(plan).toEqual({
      evict: ["stored"],
      usedBytes: 6 * GB,
      usedBytesAfter: 3 * GB,
      stillOverLimit: false,
    });
  });

  it("says when the active torrents alone are over the limit", () => {
    const allActive = planEviction({
      torrents: [torrent("a", 3, 1, true), torrent("b", 3, 2, true)],
      limitBytes: 5 * GB,
    });
    expect(allActive.evict).toEqual([]);
    expect(allActive.stillOverLimit).toBe(true);

    const mixed = planEviction({
      torrents: [torrent("playing", 8, 20, true), torrent("stored", 1, 1)],
      limitBytes: 5 * GB,
    });
    expect(mixed.evict).toEqual(["stored"]);
    expect(mixed.usedBytesAfter).toBe(8 * GB);
    expect(mixed.stillOverLimit).toBe(true);
  });

  it("breaks ties by size (bigger first), then by info hash", () => {
    const sameDay = [
      torrent("b-small", 1, 5),
      torrent("c-big", 3, 5),
      torrent("a-small", 1, 5),
    ];

    expect(planEviction({ torrents: sameDay, limitBytes: 0 }).evict).toEqual([
      "c-big",
      "a-small",
      "b-small",
    ]);
    expect(
      planEviction({ torrents: sameDay, limitBytes: 4 * GB }).evict,
    ).toEqual(["c-big"]);
  });

  it("frees what the full disk needs, oldest first, even under the limit", () => {
    const plan = planEviction({
      torrents,
      limitBytes: null,
      mustFreeBytes: 3 * GB + 1,
    });

    expect(plan).toEqual({
      evict: ["old", "middle"],
      usedBytes: 9 * GB,
      usedBytesAfter: 2 * GB,
      stillOverLimit: false,
    });
    expect(
      planEviction({ torrents, limitBytes: 100 * GB, mustFreeBytes: GB }).evict,
    ).toEqual(["old"]);
  });

  it("never frees space by deleting an active torrent", () => {
    const plan = planEviction({
      torrents: [torrent("playing", 3, 1, true), torrent("stored", 1, 20)],
      limitBytes: null,
      mustFreeBytes: 2 * GB,
    });

    expect(plan.evict).toEqual(["stored"]);
    expect(plan.usedBytesAfter).toBe(3 * GB);
  });

  it("deletes every stored torrent with a limit of 0", () => {
    expect(planEviction({ torrents, limitBytes: 0 })).toMatchObject({
      evict: ["old", "middle", "new"],
      usedBytesAfter: 0,
      stillOverLimit: false,
    });
  });

  it("handles an empty folder", () => {
    expect(planEviction({ torrents: [], limitBytes: GB })).toEqual({
      evict: [],
      usedBytes: 0,
      usedBytesAfter: 0,
      stillOverLimit: false,
    });
  });

  it.each([
    [{ torrents, limitBytes: -1 }],
    [{ torrents, limitBytes: Number.NaN }],
    [{ torrents, limitBytes: GB, mustFreeBytes: Number.POSITIVE_INFINITY }],
    [{ torrents: [{ ...torrent("x", 1, 1), bytes: -5 }], limitBytes: GB }],
    [
      {
        torrents: [{ ...torrent("x", 1, 1), lastUsedAt: Number.NaN }],
        limitBytes: GB,
      },
    ],
  ])("rejects nonsense numbers (%#)", (input) => {
    expect(() => planEviction(input)).toThrow(RangeError);
  });
});
