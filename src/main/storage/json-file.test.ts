import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJsonFile, writeJsonFile } from "./json-file";

// Real files, except where a test makes renameSync fail on purpose.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const errno = (code: string) =>
  Object.assign(new Error(`fake ${code}`), { code });

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "streamy-json-"));
  file = join(dir, "settings.json");
});

afterEach(() => {
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonFile", () => {
  it("writes readable JSON and leaves no temporary files behind", () => {
    writeJsonFile(file, { theme: "dark" });

    expect(fs.readFileSync(file, "utf8")).toBe('{\n  "theme": "dark"\n}\n');
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("replaces the previous contents", () => {
    writeJsonFile(file, { theme: "dark" });
    writeJsonFile(file, { theme: "light" });

    expect(readJsonFile(file)).toEqual({
      status: "ok",
      data: { theme: "light" },
    });
  });

  it("creates missing folders", () => {
    const nested = join(dir, "a", "b", "state.json");
    writeJsonFile(nested, [1, 2]);

    expect(readJsonFile(nested)).toEqual({ status: "ok", data: [1, 2] });
  });

  it("removes its temporary file when the save fails", () => {
    fs.mkdirSync(file); // a folder where the file should go: rename fails

    expect(() => {
      writeJsonFile(file, {});
    }).toThrow();
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("cleans up temporary files left by a save that was cut short", () => {
    const leftover = join(dir, ".settings.json.123-456.tmp");
    fs.writeFileSync(leftover, "{ half");

    writeJsonFile(file, {});

    expect(fs.existsSync(leftover)).toBe(false);
  });

  it("retries when Windows briefly locks the file", () => {
    vi.mocked(fs.renameSync)
      .mockImplementationOnce(() => {
        throw errno("EBUSY");
      })
      .mockImplementationOnce(() => {
        throw errno("EPERM");
      });

    writeJsonFile(file, { theme: "dark" });

    expect(fs.renameSync).toHaveBeenCalledTimes(3);
    expect(readJsonFile(file)).toEqual({
      status: "ok",
      data: { theme: "dark" },
    });
  });

  it("gives up on a lock that doesn't go away, keeping the old file", () => {
    writeJsonFile(file, { theme: "light" });
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw errno("EBUSY");
    });

    expect(() => {
      writeJsonFile(file, { theme: "dark" });
    }).toThrow("EBUSY");
    vi.mocked(fs.renameSync).mockRestore();
    expect(readJsonFile(file)).toEqual({
      status: "ok",
      data: { theme: "light" },
    });
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });
});

describe("readJsonFile", () => {
  it("says when there's no file yet", () => {
    expect(readJsonFile(file)).toEqual({ status: "missing" });
  });

  it("reads a file saved with a byte-order mark (e.g. by Notepad)", () => {
    fs.writeFileSync(file, '﻿{ "theme": "dark" }');

    expect(readJsonFile(file)).toEqual({
      status: "ok",
      data: { theme: "dark" },
    });
  });

  it("moves a broken file aside instead of deleting it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fs.writeFileSync(file, "{ not json");

    expect(readJsonFile(file)).toEqual({ status: "missing" });

    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const backup = files[0] ?? "";
    expect(backup).toMatch(/^settings\.json\.corrupt-\d+$/);
    expect(fs.readFileSync(join(dir, backup), "utf8")).toBe("{ not json");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says when a file exists but can't be read",
    () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fs.writeFileSync(file, "{}");
      fs.chmodSync(file, 0o000);

      expect(readJsonFile(file)).toEqual({ status: "unreadable" });
    },
  );
});
