import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirSize } from "./disk";

describe("dirSize", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "streamy-disk-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("adds up files in nested folders", async () => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "one.bin"), Buffer.alloc(100));
    await writeFile(join(dir, "a", "two.bin"), Buffer.alloc(250));
    await writeFile(join(dir, "a", "b", "three.bin"), Buffer.alloc(7));

    expect(await dirSize(dir)).toBe(357);
  });

  it("is 0 for an empty folder", async () => {
    expect(await dirSize(dir)).toBe(0);
  });

  it("is 0 for a folder that doesn't exist", async () => {
    expect(await dirSize(join(dir, "missing"))).toBe(0);
  });
});
