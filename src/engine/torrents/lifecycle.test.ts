import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTorrentLifecycle,
  IDLE_CHECK_MS,
  idleLimitMs,
  type LifecycleDeps,
  MAX_ACTIVE_TORRENTS,
  MIN_IDLE_MS,
} from "./lifecycle";
import type { TorrentUsage } from "./service";

const MINUTE = 60_000;
const START = Date.parse("2026-01-01T12:00:00Z");

/** A stand-in for the torrent service: torrents with their last use. */
class FakeTorrents {
  lastUse = new Map<string, number>();
  reading = new Set<string>();
  failed = new Set<string>();
  playing = new Set<string>();
  stopped: string[] = [];

  add(infoHash: string, lastUse = Date.now()) {
    this.lastUse.set(infoHash, lastUse);
  }

  usage = (now: number): TorrentUsage[] =>
    [...this.lastUse].map(([infoHash, lastActivityAt]) => ({
      infoHash,
      lastActivityAt,
      idleMs: this.reading.has(infoHash) ? 0 : now - lastActivityAt,
      downloaded: 0,
      failed: this.failed.has(infoHash),
    }));

  stop = (infoHash: string): Promise<void> => {
    this.lastUse.delete(infoHash);
    this.stopped.push(infoHash);
    return Promise.resolve();
  };
}

let torrents: FakeTorrents;
let keepSharing: number | null;
let onStopped: ReturnType<typeof vi.fn<(infoHash: string) => void>>;

function lifecycle(overrides: Partial<LifecycleDeps> = {}) {
  return createTorrentLifecycle({
    usage: torrents.usage,
    stop: torrents.stop,
    isPlaying: (infoHash) => torrents.playing.has(infoHash),
    keepSharingMinutes: () => keepSharing,
    onStopped,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  torrents = new FakeTorrents();
  keepSharing = 10;
  onStopped = vi.fn<(infoHash: string) => void>();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("idleLimitMs", () => {
  it("is the setting, never under a short grace, and Infinity for 'until I quit'", () => {
    expect(idleLimitMs(10)).toBe(10 * MINUTE);
    expect(idleLimitMs(0)).toBe(MIN_IDLE_MS);
    expect(MIN_IDLE_MS).toBeGreaterThanOrEqual(30_000);
    expect(MIN_IDLE_MS).toBeLessThanOrEqual(60_000);
    expect(idleLimitMs(null)).toBe(Infinity);
  });
});

describe("idle stop", () => {
  it("stops a torrent unused for the sharing time, on the 30 s check", async () => {
    const life = lifecycle();
    torrents.add("a");
    torrents.add("b");
    life.start();

    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    torrents.add("b"); // its page was polled
    await vi.advanceTimersByTimeAsync(MINUTE + IDLE_CHECK_MS);

    expect(torrents.stopped).toEqual(["a"]);
    expect(onStopped).toHaveBeenCalledWith("a");
    life.stop();
  });

  it("never stops one that's being read or played", async () => {
    const life = lifecycle();
    torrents.add("reading");
    torrents.add("playing");
    torrents.reading.add("reading");
    torrents.playing.add("playing");
    life.start();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);

    expect(torrents.stopped).toEqual([]);
    life.stop();
  });

  it("with 0 minutes, still waits out the grace (a page reload)", async () => {
    keepSharing = 0;
    const life = lifecycle();
    torrents.add("a");
    life.start();

    await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS);
    expect(torrents.stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS);
    expect(torrents.stopped).toEqual(["a"]);
    life.stop();
  });

  it("with 'until I quit', never stops anything", async () => {
    keepSharing = null;
    const life = lifecycle();
    torrents.add("a");
    life.start();

    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);

    expect(torrents.stopped).toEqual([]);
    life.stop();
  });

  it("reads the setting at every check (a change applies without a restart)", async () => {
    const life = lifecycle();
    torrents.add("a");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await life.checkIdle();
    expect(torrents.stopped).toEqual([]);

    keepSharing = 1;
    await life.checkIdle();

    expect(torrents.stopped).toEqual(["a"]);
  });

  it("runs one check at a time", async () => {
    const stopping = Promise.withResolvers<undefined>();
    const stop = vi.fn(() => stopping.promise.then(() => undefined));
    const life = lifecycle({ stop });
    torrents.add("a", START - 20 * MINUTE);

    const first = life.checkIdle();
    const second = life.checkIdle();
    expect(second).toBe(first);
    stopping.resolve(undefined);
    await first;

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps going when stopping one fails", async () => {
    const stop = vi.fn((infoHash: string) =>
      infoHash === "a"
        ? Promise.reject(new Error("busy"))
        : torrents.stop(infoHash),
    );
    const life = lifecycle({ stop });
    torrents.add("a", START - 20 * MINUTE);
    torrents.add("b", START - 20 * MINUTE);

    await life.checkIdle();

    expect(torrents.stopped).toEqual(["b"]);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("looks again before each stop: one that started playing (or was used) meanwhile stays", async () => {
    const stopping = Promise.withResolvers<undefined>();
    const stop = vi.fn((infoHash: string) =>
      infoHash === "a"
        ? stopping.promise.then(() => torrents.stop(infoHash))
        : torrents.stop(infoHash),
    );
    const life = lifecycle({ stop });
    for (const name of ["a", "b", "c"]) {
      torrents.add(name, START - 20 * MINUTE);
    }

    const check = life.checkIdle();
    // While "a" stops (destroying takes a while): the user plays "b" and
    // opens "c"'s page.
    torrents.playing.add("b");
    torrents.add("c");
    stopping.resolve(undefined);
    await check;

    expect(torrents.stopped).toEqual(["a"]);
  });

  it("stops checking once stopped", async () => {
    const life = lifecycle();
    torrents.add("a");
    life.start();
    life.stop();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);

    expect(torrents.stopped).toEqual([]);
  });
});

describe("makeRoom (at most 5 active)", () => {
  /** Torrents "t1" (used first) … "tN" (used last). */
  function addTorrents(count: number) {
    for (let i = 1; i <= count; i++) torrents.add(`t${i}`, START + i * 1000);
  }

  it("is the prototype's limit", () => {
    expect(MAX_ACTIVE_TORRENTS).toBe(5);
  });

  it("does nothing up to the limit", async () => {
    addTorrents(5);
    await lifecycle().makeRoom("t5");
    expect(torrents.stopped).toEqual([]);
  });

  it("stops the least recently used other torrent for a 6th", async () => {
    addTorrents(5);
    torrents.add("new", START - MINUTE); // even if older: it's the new one

    await lifecycle().makeRoom("new");

    expect(torrents.stopped).toEqual(["t1"]);
  });

  it("skips torrents with a live playback, and stops failed ones first", async () => {
    addTorrents(6);
    torrents.playing.add("t1");
    torrents.failed.add("t4");

    await lifecycle().makeRoom("t6");

    expect(torrents.stopped).toEqual(["t4"]);
  });

  it("looks again before each stop: one that started playing meanwhile stays", async () => {
    addTorrents(7); // two too many
    const stopping = Promise.withResolvers<undefined>();
    const stop = vi.fn((infoHash: string) =>
      infoHash === "t1"
        ? stopping.promise.then(() => torrents.stop(infoHash))
        : torrents.stop(infoHash),
    );

    const making = lifecycle({ stop }).makeRoom("t7");
    torrents.playing.add("t2");
    stopping.resolve(undefined);
    await making;

    expect(torrents.stopped).toEqual(["t1", "t3"]);
  });

  it("stops no more than needed when another one stopped meanwhile", async () => {
    addTorrents(7);
    const stopping = Promise.withResolvers<undefined>();
    const stop = vi.fn((infoHash: string) =>
      infoHash === "t1"
        ? stopping.promise.then(() => torrents.stop(infoHash))
        : torrents.stop(infoHash),
    );

    const making = lifecycle({ stop }).makeRoom("t7");
    await torrents.stop("t5"); // e.g. it was idle
    stopping.resolve(undefined);
    await making;

    expect(torrents.stopped).toEqual(["t5", "t1"]);
  });

  it("allows a 6th when every other one is playing", async () => {
    addTorrents(6);
    for (let i = 1; i <= 5; i++) torrents.playing.add(`t${i}`);

    await lifecycle().makeRoom("t6");

    expect(torrents.stopped).toEqual([]);
  });
});
