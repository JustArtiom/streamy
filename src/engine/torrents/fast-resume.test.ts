import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import parseTorrent, { toTorrentFile } from "parse-torrent";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  readTorrentRecord,
  torrentDataDir,
  writeTorrentRecord,
} from "../cache";
import { useTestRuntime } from "../test/runtime";
import {
  destroyTorrentClient,
  getTorrentClient,
  resetTorrentClientForTests,
  setTorrentClientOptionsForTests,
} from "./client";
import { torrentService } from "./service";

/*
 * Fast resume with the real WebTorrent and real files, and no peers at all:
 * everything comes from what's already on disk. A torrent's first start
 * hashes every piece; once stopped (record saved), the next start trusts
 * the record and hashes one piece per file.
 */

const PIECE = 16 * 1024;
const FILES = [
  { name: "a.bin", data: randomBytes(160 * PIECE) },
  { name: "b.bin", data: randomBytes(90 * PIECE + 123) },
];
const ALL = Buffer.concat(FILES.map((file) => file.data));
const PIECES = Math.ceil(ALL.length / PIECE);

/** A real multi-file .torrent for FILES (piece hashes and all). */
function makeTorrent(): Buffer {
  const hashes: Buffer[] = [];
  for (let offset = 0; offset < ALL.length; offset += PIECE) {
    hashes.push(
      createHash("sha1")
        .update(ALL.subarray(offset, offset + PIECE))
        .digest(),
    );
  }
  return Buffer.from(
    toTorrentFile({
      info: {
        name: Buffer.from("Movie"),
        "piece length": PIECE,
        pieces: Buffer.concat(hashes),
        files: FILES.map((file) => ({
          length: file.data.length,
          path: [Buffer.from(file.name)],
        })),
      },
    }),
  );
}

let cleanup: () => Promise<void>;
let cacheDir: string;
let torrentFile: Buffer;
let infoHash: string;
/** Pieces WebTorrent hashed since the last add. */
let verified = 0;

async function writeData(files = FILES) {
  const dir = join(torrentDataDir(cacheDir, infoHash), "Movie");
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(join(dir, file.name), file.data);
}

/** Adds the .torrent and waits until its existing data is checked. */
async function open() {
  verified = 0;
  await torrentService.add({ torrentFile });
  return vi.waitFor(
    () => {
      const torrent = torrentService.get(infoHash);
      expect(torrent.status).toBe("ready");
      return torrent;
    },
    { timeout: 10_000, interval: 20 },
  );
}

beforeAll(async () => {
  ({ cleanup, cacheDir } = await useTestRuntime());
  // A real client, kept off the network entirely.
  setTorrentClientOptionsForTests({
    dht: false,
    tracker: false,
    lsd: false,
    utPex: false,
    natUpnp: false,
    natPmp: false,
    webSeeds: false,
  });
  torrentFile = makeTorrent();
  infoHash = (await parseTorrent(torrentFile)).infoHash;
  getTorrentClient().on("add", (torrent: NodeJS.EventEmitter) => {
    torrent.on("verified", () => {
      verified += 1;
    });
  });
});

afterEach(async () => {
  for (const { infoHash: hash } of torrentService.list()) {
    await torrentService.stop(hash, { saveRecord: false });
  }
});

afterAll(async () => {
  await destroyTorrentClient();
  resetTorrentClientForTests();
  await cleanup();
});

describe("fast resume (real WebTorrent, no peers)", () => {
  it("hashes every piece the first time, then saves them all in the record", async () => {
    await writeData();

    const torrent = await open();

    expect(torrent.progress).toBe(1);
    expect(verified).toBe(PIECES);
    await torrentService.stop(infoHash);
    const record = await readTorrentRecord(cacheDir, infoHash);
    expect(record?.bitfield?.length).toBe(Math.ceil(PIECES / 8));
    expect(record?.name).toBe("Movie");
  });

  it("is complete at once from the record, hashing one piece per file, and plays from disk", async () => {
    const torrent = await open();

    expect(torrent.progress).toBe(1);
    expect(verified).toBeLessThanOrEqual(FILES.length);
    // No peers anywhere: these bytes come from the disk.
    const file = torrentService.getFile(infoHash, 1);
    const start = 40 * PIECE + 7;
    const end = start + 3 * PIECE;
    const bytes = await buffer(file.createReadStream({ start, end }));
    const expected = FILES[1]?.data.subarray(start, end + 1);
    expect(expected && bytes.equals(expected)).toBe(true);
  });

  it("checks everything when the record's bitfield has the wrong length", async () => {
    await torrentService.stop(infoHash, { saveRecord: false });
    // Claims everything, but b.bin is gone.
    await writeTorrentRecord(cacheDir, infoHash, {
      name: "Movie",
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
      bitfield: new Uint8Array(Math.ceil(PIECES / 8) + 1).fill(0xff),
    });
    await rm(join(torrentDataDir(cacheDir, infoHash), "Movie", "b.bin"));

    const torrent = await open();

    expect(verified).toBeLessThan(PIECES); // b.bin's pieces don't verify
    expect(torrent.files.map((f) => f.progress)).toEqual([1, 0]);
    expect(torrent.progress).toBeLessThan(1);
  });

  it("re-checks a file whose data changed behind the record's back", async () => {
    await writeData();
    await open();
    await torrentService.stop(infoHash); // a full record
    // Someone overwrote b.bin.
    await writeData([
      { name: "b.bin", data: randomBytes(FILES[1]?.data.length ?? 0) },
    ]);

    const torrent = await open();

    expect(torrent.files.map((f) => f.progress)).toEqual([1, 0]);
  });
});
