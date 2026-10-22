import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSecretsForTests, registerSecret } from "../shared/redact";
import { createMainLogger, rotateLogFile, serializeError } from "./logs";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "streamy-logs-"));
  file = join(dir, "main.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSecretsForTests();
});

const read = (name: string) => readFileSync(join(dir, name), "utf8");

describe("rotateLogFile", () => {
  it("does nothing while the file is small, or missing", () => {
    rotateLogFile(file, { maxBytes: 10 });
    expect(readdirSync(dir)).toEqual([]);

    writeFileSync(file, "small");
    rotateLogFile(file, { maxBytes: 10 });
    expect(readdirSync(dir)).toEqual(["main.log"]);
  });

  it("sets a big file aside and keeps the newest three", () => {
    for (const run of ["first", "second", "third", "fourth"]) {
      writeFileSync(file, `${run} run, long enough`);
      rotateLogFile(file, { maxBytes: 10, keep: 3 });
    }

    expect(existsSync(file)).toBe(false);
    expect(read("main.log.1")).toMatch(/^fourth/);
    expect(read("main.log.2")).toMatch(/^third/);
    expect(read("main.log.3")).toMatch(/^second/);
    expect(readdirSync(dir).sort()).toEqual([
      "main.log.1",
      "main.log.2",
      "main.log.3",
    ]);
  });
});

describe("createMainLogger", () => {
  it("writes JSON lines to main.log, without the host name", () => {
    const log = createMainLogger(dir);
    log.info({ port: 1234 }, "Engine is running");

    const [line] = read("main.log").trim().split("\n");
    const entry = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ msg: "Engine is running", port: 1234 });
    expect(entry.hostname).toBeUndefined();
    expect(typeof entry.time).toBe("string");
  });

  it("hides fields that must never be logged", () => {
    const log = createMainLogger(dir);
    log.info(
      { secret: "s3cret", engine: { token: "t0ken" }, magnet: "magnet:?xt=1" },
      "oops",
    );

    const text = read("main.log");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("t0ken");
    expect(text).not.toContain("magnet:?xt=1");
  });

  it("runs every line through redact(): magnet links, the engine secret", () => {
    const secret = "f".repeat(64);
    registerSecret(secret);
    const log = createMainLogger(dir);
    // Text the engine printed, which main logs as it is.
    log.warn(
      { engine: "stderr" },
      `adding magnet:?xt=urn:btih:abc123&dn=My.Holiday.Video secret=${secret}`,
    );

    const text = read("main.log");
    expect(text).toContain("magnet:?xt=urn:btih:abc123");
    expect(text).not.toContain("Holiday");
    expect(text).not.toContain(secret);
  });

  it("logs errors without the file paths Node puts in them", () => {
    const missing = join(dir, "Private Movie (2026).torrent");
    let error: unknown;
    try {
      readFileSync(missing);
    } catch (caught) {
      error = caught;
    }
    const log = createMainLogger(dir);
    log.warn({ err: error }, "Could not read a file");

    const text = read("main.log");
    expect(text).not.toContain("Private Movie");
    const entry = JSON.parse(text.trim()) as { err: Record<string, unknown> };
    expect(entry.err).toMatchObject({ code: "ENOENT", syscall: "open" });
    expect(entry.err.path).toBeUndefined();
    expect(entry.err.message).toContain("[path]");
  });

  it("creates the folder if needed", () => {
    const nested = join(dir, "a", "logs");
    createMainLogger(nested).info("hello");
    expect(existsSync(join(nested, "main.log"))).toBe(true);
  });
});

describe("serializeError", () => {
  it("drops path and dest, from causes and grouped errors too", () => {
    const copy = Object.assign(
      new Error("EXDEV: cross-device link, rename '/a/x.mkv' -> '/b/x.mkv'"),
      { code: "EXDEV", path: "/a/x.mkv", dest: "/b/x.mkv" },
    );
    const wrapped = new Error("Moving failed", { cause: copy });
    const grouped = new AggregateError([copy], "Several failed");

    for (const error of [copy, wrapped, grouped]) {
      const text = JSON.stringify(serializeError(error));
      expect(text).not.toContain("x.mkv");
      expect(text).toContain("[path]");
    }
    expect(serializeError(copy)).toMatchObject({ code: "EXDEV" });
  });

  it("leaves things that aren't errors alone", () => {
    expect(serializeError("text")).toBe("text");
    expect(serializeError(null)).toBeNull();
  });
});
