import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiskGuard,
  DISK_CHECK_MS,
  RESUME_FREE_BYTES,
  shouldPause,
} from "./disk-guard";
import { LOW_DISK_BYTES } from "./disk-space";

const GB = 1024 ** 3;

describe("shouldPause", () => {
  it("pauses under 1 GB and resumes only above 1.5 GB", () => {
    expect(LOW_DISK_BYTES).toBe(GB);
    expect(RESUME_FREE_BYTES).toBe(1.5 * GB);

    expect(shouldPause(false, 2 * GB)).toBe(false);
    expect(shouldPause(false, GB - 1)).toBe(true);
    // In between: stays as it is.
    expect(shouldPause(false, 1.2 * GB)).toBe(false);
    expect(shouldPause(true, 1.2 * GB)).toBe(true);
    expect(shouldPause(true, 1.5 * GB)).toBe(false);
  });

  it("never pauses on unknown free space", () => {
    expect(shouldPause(false, null)).toBe(false);
    expect(shouldPause(true, null)).toBe(false);
  });
});

describe("the guard", () => {
  let free: number | null;
  let downloading: boolean;
  let paused: boolean[];

  function guard() {
    return createDiskGuard({
      cacheDir: () => "/videos",
      isDownloading: () => downloading,
      setPaused: (value) => paused.push(value),
      freeSpace: () => Promise.resolve(free),
    });
  }

  beforeEach(() => {
    free = 10 * GB;
    downloading = true;
    paused = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses when the disk fills up and resumes once there's room again", async () => {
    const disk = guard();
    expect(await disk.check()).toBe(false);

    free = 0.5 * GB;
    expect(await disk.check()).toBe(true);
    expect(disk.isLow()).toBe(true);

    free = 1.2 * GB; // not enough yet
    expect(await disk.check()).toBe(true);

    free = 3 * GB;
    expect(await disk.check()).toBe(false);
    expect(paused).toEqual([true, false]);
  });

  it("keeps its state when measuring fails", async () => {
    const disk = createDiskGuard({
      cacheDir: () => "/videos",
      isDownloading: () => true,
      setPaused: (value) => paused.push(value),
      freeSpace: () => Promise.reject(new Error("statfs")),
    });
    expect(await disk.check()).toBe(false);
    expect(paused).toEqual([]);
  });

  it("measures every 15 s while something downloads, or while paused", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const freeSpace = vi.fn(() => Promise.resolve(free));
    const disk = createDiskGuard({
      cacheDir: () => "/videos",
      isDownloading: () => downloading,
      setPaused: (value) => paused.push(value),
      freeSpace,
    });
    disk.start();

    await vi.advanceTimersByTimeAsync(DISK_CHECK_MS);
    expect(freeSpace).toHaveBeenCalledTimes(1);

    downloading = false;
    await vi.advanceTimersByTimeAsync(DISK_CHECK_MS);
    expect(freeSpace).toHaveBeenCalledTimes(1);

    free = 0.1 * GB;
    await disk.check(); // e.g. after a policy run
    await vi.advanceTimersByTimeAsync(DISK_CHECK_MS);
    expect(freeSpace).toHaveBeenCalledTimes(3);

    disk.stop();
    await vi.advanceTimersByTimeAsync(10 * DISK_CHECK_MS);
    expect(freeSpace).toHaveBeenCalledTimes(3);
  });
});
