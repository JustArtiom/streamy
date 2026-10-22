import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  createCachePolicy,
  torrentDataDir,
  torrentRecordFile,
  writeTorrentRecord,
} from "../cache";
import { getRuntime } from "../config";
import { AppError, ErrorCode } from "../http/errors";
import {
  fakeClient,
  type FakeTorrent,
  makeTorrentFile,
} from "../test/fake-torrent-client";
import { useTestRuntime } from "../test/runtime";
import { setInternalOrigin } from "./file-tokens";
import {
  deleteStoredTorrent,
  settleAllTorrents,
  torrentService,
  torrentUsage,
} from "./service";

/*
 * One torrent, two things happening to it at once: an open while a delete,
 * a stop or an eviction is still going (each of those takes a while: the
 * torrent's goodbye to trackers, disk I/O). Gates hold each slow step so
 * the interleaving is the same every run.
 */

const gates = vi.hoisted(() => ({
  /** Holds deleteTorrentData (the disk work of a delete). */
  delete: null as Gate | null,
  /** Holds ensureVideoFolder (the first disk work of an add). */
  folder: null as Gate | null,
}));

/** A held step: it calls `entered`, then waits for `promise`. */
interface Gate {
  promise: Promise<void>;
  entered: () => void;
}

vi.mock("./client", async () => {
  const { fakeClient } = await import("../test/fake-torrent-client");
  return {
    getTorrentClient: () => fakeClient,
    destroyTorrentClient: () => Promise.resolve(),
    setDownloadsPaused: () => undefined,
  };
});

vi.mock("../cache/clean", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cache/clean")>();
  return {
    ...actual,
    deleteTorrentData: async (cacheDir: string, infoHash: string) => {
      const held = gates.delete;
      if (held) {
        held.entered();
        await held.promise;
      }
      return actual.deleteTorrentData(cacheDir, infoHash);
    },
  };
});

vi.mock("../lib/video-folder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/video-folder")>();
  return {
    ...actual,
    ensureVideoFolder: async (cacheDir?: string) => {
      const held = gates.folder;
      if (held) {
        held.entered();
        await held.promise;
      }
      return actual.ensureVideoFolder(cacheDir);
    },
  };
});

const { bytes: TORRENT, infoHash: HASH } = makeTorrentFile({
  name: "Movie",
  files: [{ path: ["Movie.mkv"], length: 100_000 }],
});

let cleanup: () => Promise<void>;
let cacheDir: string;

beforeAll(async () => {
  ({ cleanup, cacheDir } = await useTestRuntime());
  setInternalOrigin("http://127.0.0.1:4321");
});

afterAll(async () => {
  setInternalOrigin(null);
  await cleanup();
});

afterEach(async () => {
  gates.delete = null;
  gates.folder = null;
  await torrentService.remove(HASH, { forget: true });
  await settleAllTorrents();
  fakeClient.torrents = [];
});

/**
 * A gate the test opens by hand. `reached` resolves once the held step has
 * started. Wait for that, not for a number of event-loop turns: real disk
 * work before the step takes longer on slow machines (CI).
 */
function gate() {
  const opened = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  return {
    promise: opened.promise.then(() => undefined),
    entered: () => {
      entered.resolve(undefined);
    },
    reached: entered.promise,
    open: () => {
      opened.resolve(undefined);
    },
  };
}

/** Lets everything that isn't held run. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

const dataDir = () => torrentDataDir(cacheDir, HASH);
const recordFile = () => torrentRecordFile(cacheDir, HASH);

/** HASH stored by an earlier run: some data, and a record claiming it. */
async function storeOnDisk() {
  await mkdir(join(dataDir(), "Movie"), { recursive: true });
  await writeFile(join(dataDir(), "Movie", "Movie.mkv"), Buffer.alloc(50, 1));
  await writeTorrentRecord(cacheDir, HASH, {
    name: "Movie",
    addedAt: 1,
    lastUsedAt: 2,
    bitfield: new Uint8Array([0x80]),
  });
}

/** The torrent new pieces land in. */
async function writePiece() {
  await mkdir(join(dataDir(), "Movie"), { recursive: true });
  await writeFile(join(dataDir(), "Movie", "Movie.mkv"), Buffer.alloc(10, 2));
}

/** Opens HASH and gives it its metadata; its destroy then waits for a gate. */
async function openWithSlowDestroy() {
  await torrentService.add({ torrentFile: TORRENT });
  const torrent = fakeClient.get(HASH);
  await torrent.receiveMetadata("Movie", [{ path: "Movie/Movie.mkv" }]);
  const destroyed = gate();
  torrent.destroy = function (this: FakeTorrent, options, callback) {
    this.destroyed = true;
    this.destroyOptions = options;
    this.emit("close");
    void destroyed.promise.then(() => callback?.(null));
  };
  return destroyed;
}

function evictEverything() {
  return createCachePolicy({
    config: () => ({ cacheDir, cacheLimitBytes: 0 }),
    activeTorrents: () => torrentUsage(),
    deleteStored: deleteStoredTorrent,
    stopBackgroundDownload: () => undefined,
  });
}

describe("an open while a delete is still going", () => {
  it("waits for it, then starts fresh: the new torrent's data is never deleted", async () => {
    await storeOnDisk();
    const destroyed = await openWithSlowDestroy();

    const removing = torrentService.remove(HASH);
    const reopening = torrentService.add({ torrentFile: TORRENT });
    await settle();
    expect(fakeClient.torrents).toHaveLength(1); // still waiting

    destroyed.open();
    await removing;
    const reopened = await reopening;
    await writePiece();
    await settleAllTorrents();

    expect(reopened.created).toBe(true);
    expect(fakeClient.get(HASH).options).not.toHaveProperty("bitfield");
    expect(existsSync(join(dataDir(), "Movie", "Movie.mkv"))).toBe(true);
  });
});

describe("a delete while an open is still going", () => {
  it("waits for the open, then deletes what it opened", async () => {
    await storeOnDisk();
    const folder = gate();
    gates.folder = folder;

    const opening = torrentService.add({ torrentFile: TORRENT });
    await folder.reached;
    const removing = torrentService.remove(HASH);
    folder.open();
    await opening;
    await removing;

    expect(torrentService.isActive(HASH)).toBe(false);
    expect(existsSync(dataDir())).toBe(false);
    expect(existsSync(recordFile())).toBe(false);
  });
});

describe("a stop still going, then DELETE", () => {
  it("deletes after the stop: no record is left claiming deleted data", async () => {
    await storeOnDisk();
    const destroyed = await openWithSlowDestroy();

    const stopping = torrentService.stop(HASH); // an idle stop
    const removing = torrentService.remove(HASH); // the user deletes it
    destroyed.open();
    await Promise.all([stopping, removing]);

    expect(existsSync(recordFile())).toBe(false);
    expect(existsSync(dataDir())).toBe(false);
  });

  it("a record save already queued doesn't land after the delete either", async () => {
    await torrentService.add({ torrentFile: TORRENT });
    const torrent = fakeClient.get(HASH);
    await torrent.receiveMetadata("Movie", [{ path: "Movie/Movie.mkv" }]);
    torrent.verifyPiece(0);

    torrent.complete(); // saves the record now (queued)
    await torrentService.remove(HASH);
    await settleAllTorrents();

    expect(existsSync(recordFile())).toBe(false);
  });
});

describe("eviction and opening the same torrent", () => {
  it("an eviction already deleting: the open waits, then starts fresh", async () => {
    await storeOnDisk();
    const deleting = gate();
    gates.delete = deleting;

    const run = evictEverything().run();
    await deleting.reached; // it measured, and its deletion is held
    const opening = torrentService.add({ torrentFile: TORRENT });
    await settle();
    expect(fakeClient.torrents).toHaveLength(0); // waiting for the delete

    deleting.open();
    expect(await run).toMatchObject({ status: "done", evicted: [HASH] });
    expect((await opening).created).toBe(true);
    expect(fakeClient.get(HASH).options).not.toHaveProperty("bitfield");
    await writePiece();
    await settleAllTorrents();
    expect(existsSync(join(dataDir(), "Movie", "Movie.mkv"))).toBe(true);
  });

  it("an open already going: the eviction leaves it alone", async () => {
    await storeOnDisk();
    const folder = gate();
    gates.folder = folder;

    const opening = torrentService.add({ torrentFile: TORRENT });
    await folder.reached;
    const run = await evictEverything().run();
    folder.open();
    await opening;

    expect(run).toMatchObject({ status: "done", evicted: [] });
    // It resumed from its record, and both are still there.
    expect(fakeClient.get(HASH).options.bitfield).toEqual(Buffer.from([0x80]));
    expect(existsSync(recordFile())).toBe(true);
    expect(existsSync(join(dataDir(), "Movie", "Movie.mkv"))).toBe(true);
  });

  it("refuses at once for an active torrent", async () => {
    await torrentService.add({ torrentFile: TORRENT });
    expect(await deleteStoredTorrent(cacheDir, HASH)).toBe(false);
  });
});

describe('"Clear now" and an open that started just before', () => {
  it("refuses the open (it's asked last), so nothing runs on deleted data", async () => {
    await storeOnDisk();
    const policy = createCachePolicy({
      config: () => getRuntime().config,
      activeTorrents: () => torrentUsage(),
      deleteStored: deleteStoredTorrent,
      stopBackgroundDownload: () => undefined,
    });
    const folder = gate();
    gates.folder = folder;
    const opening = torrentService.add(
      { torrentFile: TORRENT },
      {
        admit: () => {
          if (policy.isClearing()) {
            throw new AppError(ErrorCode.ServiceUnavailable, "Clearing");
          }
        },
      },
    );
    const refused = opening.then(
      () => null,
      (err: unknown) => err,
    );
    await folder.reached;

    await policy.clear(async () => {
      // The open gets past the folder check while the clear runs.
      folder.open();
      await refused;
    });

    expect(await refused).toMatchObject({
      code: ErrorCode.ServiceUnavailable,
    });
    expect(torrentService.isActive(HASH)).toBe(false);
    expect(existsSync(dataDir())).toBe(false);
  });
});
