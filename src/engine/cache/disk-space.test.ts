import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freeSpace, isLowDisk, LOW_DISK_BYTES } from "./disk-space";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-space-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("freeSpace", () => {
  it("tells the free space on a folder's disk", async () => {
    const free = await freeSpace(root);

    expect(free).toBeGreaterThan(0);
    expect(Number.isSafeInteger(free)).toBe(true);
  });

  it("is null when it can't be told", async () => {
    expect(await freeSpace(join(root, "unplugged"))).toBeNull();
  });
});

describe("isLowDisk", () => {
  it("is low under 1 GiB", () => {
    expect(LOW_DISK_BYTES).toBe(1024 ** 3);
    expect(isLowDisk(LOW_DISK_BYTES - 1)).toBe(true);
    expect(isLowDisk(0)).toBe(true);
    expect(isLowDisk(LOW_DISK_BYTES)).toBe(false);
  });

  it("never pauses on a guess: unknown isn't low", () => {
    expect(isLowDisk(null)).toBe(false);
  });
});
