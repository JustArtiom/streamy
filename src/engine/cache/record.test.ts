import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { CACHE_MARKER } from "./layout";
import {
  isRecordTempFile,
  readTorrentRecord,
  type RecordLogger,
  type TorrentRecord,
  writeTorrentRecord,
} from "./record";

// Real files, except where a test makes rename fail on purpose.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const A = "a".repeat(40);
const errno = (code: string) =>
  Object.assign(new Error(`fake ${code}`), { code });

let root: string;
let cacheDir: string;
let logger: { warn: Mock<RecordLogger["warn"]> };

const record: TorrentRecord = {
  name: "Sintel",
  addedAt: Date.UTC(2026, 0, 1),
  lastUsedAt: Date.UTC(2026, 0, 2),
  // 12 pieces: the first 8 and the 10th downloaded.
  bitfield: new Uint8Array([0xff, 0x40]),
};

const recordFile = () => join(cacheDir, "torrents", `${A}.streamy.json`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "streamy-record-"));
  cacheDir = join(root, "Cache");
  mkdirSync(cacheDir);
  writeFileSync(join(cacheDir, CACHE_MARKER), "");
  logger = { warn: vi.fn() };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeTorrentRecord and readTorrentRecord", () => {
  it("round-trip a record, bitfield included", async () => {
    await writeTorrentRecord(cacheDir, A, record);

    const read = await readTorrentRecord(cacheDir, A, logger);

    expect(read?.bitfield).toBeInstanceOf(Uint8Array);
    expect({ ...read, bitfield: Array.from(read?.bitfield ?? []) }).toEqual({
      ...record,
      bitfield: [0xff, 0x40],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("round-trip a record without a bitfield", async () => {
    await writeTorrentRecord(cacheDir, A, { ...record, bitfield: null });

    expect(await readTorrentRecord(cacheDir, A)).toEqual({
      ...record,
      bitfield: null,
    });
  });

  it("write readable JSON next to the torrent's folder, and no temp files", async () => {
    await writeTorrentRecord(cacheDir, A, record);

    expect(JSON.parse(readFileSync(recordFile(), "utf8"))).toEqual({
      name: "Sintel",
      addedAt: record.addedAt,
      lastUsedAt: record.lastUsedAt,
      bitfield: "/0A=",
    });
    expect(readdirSync(join(cacheDir, "torrents"))).toEqual([
      `${A}.streamy.json`,
    ]);
  });

  it("replace the previous record", async () => {
    await writeTorrentRecord(cacheDir, A, record);
    await writeTorrentRecord(cacheDir, A, { ...record, lastUsedAt: 99 });

    expect((await readTorrentRecord(cacheDir, A))?.lastUsedAt).toBe(99);
  });
});

describe("readTorrentRecord", () => {
  it("is null, quietly, when there's no record", async () => {
    expect(await readTorrentRecord(cacheDir, A, logger)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["broken JSON", "{ half"],
    ["JSON null", "null"],
    ["no name", JSON.stringify({ addedAt: 1, lastUsedAt: 1, bitfield: null })],
    [
      "a negative time",
      JSON.stringify({ name: "x", addedAt: -1, lastUsedAt: 1, bitfield: null }),
    ],
    [
      "a bitfield that isn't base64",
      JSON.stringify({ name: "x", addedAt: 1, lastUsedAt: 1, bitfield: "%%" }),
    ],
  ])("treats %s as no record, and logs it", async (_what, text) => {
    mkdirSync(join(cacheDir, "torrents"));
    writeFileSync(recordFile(), text);

    expect(await readTorrentRecord(cacheDir, A, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      { file: recordFile() },
      "Ignoring a broken resume record",
    );
  });

  it("ignores fields it doesn't know (from a newer Streamy)", async () => {
    mkdirSync(join(cacheDir, "torrents"));
    writeFileSync(
      recordFile(),
      JSON.stringify({ ...record, bitfield: null, pieceCount: 12 }),
    );

    expect(await readTorrentRecord(cacheDir, A)).toEqual({
      ...record,
      bitfield: null,
    });
  });

  it("refuses a bad info hash", async () => {
    await expect(readTorrentRecord(cacheDir, "../x")).rejects.toThrow(
      TypeError,
    );
  });
});

describe("writeTorrentRecord's safety", () => {
  it("never creates the video folder itself", async () => {
    const unplugged = join(root, "unplugged");

    await expect(writeTorrentRecord(unplugged, A, record)).rejects.toThrow(
      /ENOENT/,
    );
    expect(readdirSync(root)).toEqual(["Cache"]);
  });

  it("rejects a bad record or info hash", async () => {
    await expect(
      writeTorrentRecord(cacheDir, A, { ...record, addedAt: Number.NaN }),
    ).rejects.toThrow();
    await expect(writeTorrentRecord(cacheDir, "..", record)).rejects.toThrow(
      TypeError,
    );
  });

  it("retries when Windows briefly locks the file", async () => {
    vi.mocked(fsPromises.rename)
      .mockRejectedValueOnce(errno("EBUSY"))
      .mockRejectedValueOnce(errno("EPERM"));

    await writeTorrentRecord(cacheDir, A, record);

    expect(fsPromises.rename).toHaveBeenCalledTimes(3);
    expect((await readTorrentRecord(cacheDir, A))?.name).toBe("Sintel");
  });

  it("keeps the old record, and no temp file, when the save fails", async () => {
    await writeTorrentRecord(cacheDir, A, record);
    vi.mocked(fsPromises.rename).mockClear();
    vi.mocked(fsPromises.rename).mockRejectedValue(errno("EIO"));

    await expect(
      writeTorrentRecord(cacheDir, A, { ...record, name: "Changed" }),
    ).rejects.toThrow("EIO");

    expect((await readTorrentRecord(cacheDir, A))?.name).toBe("Sintel");
    expect(readdirSync(join(cacheDir, "torrents"))).toEqual([
      `${A}.streamy.json`,
    ]);
    // The temp file it tried is one cleanStartup would recognise.
    const temp = vi.mocked(fsPromises.rename).mock.calls[0]?.[0];
    expect(isRecordTempFile(basename(String(temp)))).toBe(true);
  });
});

describe("isRecordTempFile", () => {
  it("recognises only temp files of records", () => {
    expect(isRecordTempFile(`.${A}.streamy.json.123-0a1b2c3d.tmp`)).toBe(true);
    expect(isRecordTempFile(`${A}.streamy.json`)).toBe(false);
    expect(isRecordTempFile(".settings.json.123-456.tmp")).toBe(false);
    expect(isRecordTempFile(`.${A}.streamy.json.tmp`)).toBe(false);
  });
});
