import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import {
  closeLogFile,
  logger,
  openLogFile,
  rotateLogFile,
  serializeError,
} from "./logger";
import {
  clearSecretsForTests,
  redact,
  registerSecret,
} from "../../shared/redact";

const SECRET = "5ec4e7".repeat(10);
const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";

describe("redact", () => {
  afterEach(() => {
    clearSecretsForTests();
  });

  it("hides file tokens", () => {
    expect(
      redact(
        "http://127.0.0.1:5000/internal/files/AbC_d-1234567890: I/O error",
      ),
    ).toBe("http://127.0.0.1:5000/internal/files/[token]: I/O error");
  });

  it("keeps only the info hash of magnet links", () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=My.Movie.2025&tr=udp%3A%2F%2Ft.example%3A1337`;
    expect(redact(`{"input":"${magnet}","x":1}`)).toBe(
      `{"input":"magnet:?xt=urn:btih:${HASH}","x":1}`,
    );
    expect(redact("magnet:?dn=no-hash")).toBe("magnet:?[redacted]");
  });

  it("hides the registered secret", () => {
    registerSecret(SECRET);
    expect(redact(`key=${SECRET};`)).toBe("key=[secret];");
  });

  it("leaves everything else alone", () => {
    const line = '{"level":30,"msg":"Torrent added","infoHash":"abc"}';
    expect(redact(line)).toBe(line);
  });
});

describe("the log file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "streamy-log-test-"));
  });

  afterEach(async () => {
    closeLogFile();
    clearSecretsForTests();
    await rm(dir, { recursive: true, force: true });
  });

  async function readLines(file: string) {
    closeLogFile(); // flushes synchronously
    return (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("writes redacted JSON lines, from children made before it opened", async () => {
    // Like modules do at import time, before init says where to write.
    const child = logger.child({ module: "test" });
    registerSecret(SECRET);

    const file = await openLogFile({ dir, level: "info" });
    child.info(
      {
        input: "http://127.0.0.1:1/internal/files/secretToken123",
        magnet: `magnet:?xt=urn:btih:${HASH}&dn=Private.Name`,
      },
      `secret is ${SECRET}`,
    );
    child.debug("not at info level");

    const lines = await readLines(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      module: "test",
      msg: "secret is [secret]",
      input: "http://127.0.0.1:1/internal/files/[token]",
      magnet: `magnet:?xt=urn:btih:${HASH}`,
      level: 30,
    });
    expect(lines[0]).not.toHaveProperty("hostname");
  });

  it("logs errors without the file paths they carry (names say what's watched)", async () => {
    const file = await openLogFile({ dir, level: "info" });
    const path = "/Users/me/Videos/torrents/abc/Secret.Movie.2025/Secret.mkv";
    const err = Object.assign(
      new Error(`ENOENT: no such file or directory, open '${path}'`),
      { code: "ENOENT", syscall: "open", path },
    );

    logger.child({ module: "test" }).warn({ err }, "Couldn't open a file");

    const [line] = await readLines(file);
    expect(line?.err).toMatchObject({
      type: "Error",
      code: "ENOENT",
      syscall: "open",
      message: "ENOENT: no such file or directory, open '[path]'",
    });
    expect(line?.err).not.toHaveProperty("path");
    expect(JSON.stringify(line)).not.toContain("Secret");
  });

  it("is silent before it's opened and after it's closed", () => {
    expect(logger.level).toBe("silent");
  });

  it("rotates a big file at open, keeping 3 old ones", async () => {
    const file = join(dir, "engine.log");
    await writeFile(file, "now");
    await writeFile(`${file}.1`, "one");
    await writeFile(`${file}.2`, "two");
    await writeFile(`${file}.3`, "three");

    await rotateLogFile(file, { maxBytes: 2 });

    expect(existsSync(file)).toBe(false);
    expect(await readFile(`${file}.1`, "utf8")).toBe("now");
    expect(await readFile(`${file}.2`, "utf8")).toBe("one");
    expect(await readFile(`${file}.3`, "utf8")).toBe("two");
    expect(existsSync(`${file}.4`)).toBe(false);
  });

  it("leaves a small file alone, and copes with none at all", async () => {
    const file = join(dir, "engine.log");
    await rotateLogFile(file, { maxBytes: 2 });
    await writeFile(file, "ok");
    await rotateLogFile(file, { maxBytes: 2 });
    expect(await readFile(file, "utf8")).toBe("ok");
  });
});

describe("serializeError", () => {
  it("cuts paths from causes, renames and quoted paths it wasn't told about", () => {
    const rename = Object.assign(
      new Error(
        "EXDEV: cross-device link not permitted, rename '/a/Secret.mkv' -> '/b/Secret.mkv'",
      ),
      { code: "EXDEV", path: "/a/Secret.mkv", dest: "/b/Secret.mkv" },
    );
    const wrapped = new Error("Couldn't move it", { cause: rename });
    const told = new Error("open 'C:\\Users\\me\\Secret.mkv' failed");

    const out = JSON.stringify([serializeError(wrapped), serializeError(told)]);

    expect(out).not.toContain("Secret");
    expect(out).toContain("[path]");
  });

  it("takes an error pino-http already serialized, and leaves non-errors alone", () => {
    const err = Object.assign(
      new Error("EACCES: permission denied, open '/x/Secret.mkv'"),
      {
        path: "/x/Secret.mkv",
      },
    );

    const out = serializeError(pino.stdSerializers.err(err));

    expect(JSON.stringify(out)).not.toContain("Secret");
    expect(serializeError("text")).toBe("text");
    expect(serializeError(undefined)).toBeUndefined();
  });
});
