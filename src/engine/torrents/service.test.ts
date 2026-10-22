import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { toTorrentFile } from "parse-torrent";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  readTorrentRecord,
  torrentDataDir,
  torrentRecordFile,
  writeTorrentRecord,
} from "../cache";
import {
  cachePaths,
  DEFAULT_TRACKERS,
  getRuntime,
  MAX_TORRENT_FILES,
  updateConfig,
  updateTuning,
} from "../config";
import { AppError, ErrorCode } from "../http/errors";
import {
  fakeClient,
  type FakeTorrent,
  makeTorrentFile,
  torrentFileFor,
} from "../test/fake-torrent-client";
import { makeVideoFolder, useTestRuntime } from "../test/runtime";
import {
  activeFileTokenCount,
  resolveFileToken,
  revokeAllFileTokens,
  setInternalOrigin,
} from "./file-tokens";
import { UNSAFE_NAMES_MESSAGE } from "./contents";
import {
  hasUnfinishedTorrents,
  pauseDownloads,
  RECORD_SAVE_MS,
  type SavedTorrent,
  saveTorrentRecords,
  settleAllTorrents,
  stopBackgroundDownload,
  type TorrentMetadataEvent,
  type TorrentRemoval,
  torrentService,
  torrentUsage,
} from "./service";

const clientState = vi.hoisted(() => ({ downloadsPaused: false }));

vi.mock("./client", async () => {
  const { fakeClient } = await import("../test/fake-torrent-client");
  return {
    getTorrentClient: () => fakeClient,
    destroyTorrentClient: () => Promise.resolve(),
    setDownloadsPaused: (paused: boolean) => {
      clientState.downloadsPaused = paused;
    },
  };
});

const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
const HASH_BASE32 = "BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ";
const OTHER = "c9e15763f722f23e98a29decdfae341b98d53056";

/** Expects `fn` to throw an AppError with this code (and message). */
async function expectAppError(
  fn: () => unknown,
  code: ErrorCode,
  message?: string | RegExp,
) {
  const error: unknown = await Promise.resolve()
    .then(fn)
    .then(
      () => null,
      (err: unknown) => err,
    );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  if (message) expect((error as AppError).message).toMatch(message);
}

/** Adds a torrent and gives it its metadata: a video, a subtitle and a text file. */
async function addReady(infoHash = HASH): Promise<FakeTorrent> {
  await torrentService.add({ magnet: infoHash });
  const torrent = fakeClient.get(infoHash);
  await torrent.receiveMetadata("Sintel", [
    { path: "Sintel/Sintel.mp4", data: Buffer.from("0123456789".repeat(10)) },
    {
      path: "Sintel/Sintel.en.srt",
      data: Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHi\n"),
    },
    { path: "Sintel/readme.txt" },
  ]);
  return torrent;
}

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const { infoHash } of torrentService.list()) {
    await torrentService.remove(infoHash);
  }
  fakeClient.torrents = [];
  revokeAllFileTokens();
});

describe("add", () => {
  it("adds a magnet with nothing selected, in its own folder, with extra trackers", async () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`;
    const { torrent, created } = await torrentService.add({ magnet });

    expect(created).toBe(true);
    expect(torrent).toMatchObject({
      infoHash: HASH,
      name: null,
      status: "fetching_metadata",
      error: null,
      size: null,
      progress: 0,
      files: [],
      addedAt: "2026-01-01T12:00:00.000Z",
      lastActivityAt: "2026-01-01T12:00:00.000Z",
    });
    const added = fakeClient.get(HASH);
    expect(added.torrentId).toBe(magnet);
    // No destroyStoreOnDestroy: stopping (or quitting) keeps the data.
    expect(added.options).toEqual({
      path: join(cachePaths().torrents, HASH),
      deselect: true,
      announce: DEFAULT_TRACKERS,
    });
  });

  it("turns a bare info hash into a magnet", async () => {
    await torrentService.add({ magnet: HASH.toUpperCase() });
    expect(fakeClient.get(HASH).torrentId).toBe(`magnet:?xt=urn:btih:${HASH}`);
  });

  it("understands base32 info hashes", async () => {
    const { torrent } = await torrentService.add({
      magnet: `magnet:?xt=urn:btih:${HASH_BASE32}`,
    });
    expect(torrent.infoHash).toBe(HASH);
  });

  it("returns the existing torrent instead of adding it twice", async () => {
    await torrentService.add({ magnet: HASH });
    const again = await torrentService.add({
      magnet: `magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=x`,
    });

    expect(again.created).toBe(false);
    expect(again.torrent.infoHash).toBe(HASH);
    expect(fakeClient.torrents).toHaveLength(1);
  });

  it("adds a double click only once", async () => {
    const results = await Promise.all([
      torrentService.add({ magnet: HASH }),
      torrentService.add({ magnet: HASH }),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    expect(fakeClient.torrents).toHaveLength(1);
  });

  it.each([
    ["not a magnet", /magnet link/],
    [`magnet:?xt=urn:btmh:1220${"a".repeat(64)}`, /v2-only/],
    ["magnet:?dn=nothing", /no BitTorrent info hash/],
  ])("rejects %j with 400", async (magnet, message) => {
    await expectAppError(
      () => torrentService.add({ magnet }),
      ErrorCode.BadRequest,
      message,
    );
    expect(fakeClient.torrents).toHaveLength(0);
  });

  it("adds a .torrent file by its bytes", async () => {
    const { bytes, infoHash } = makeTorrentFile({
      name: "Movie",
      files: [{ path: ["movie.mkv"], length: 1000 }],
    });

    const { torrent, created } = await torrentService.add({
      torrentFile: bytes,
    });

    expect(created).toBe(true);
    expect(torrent.infoHash).toBe(infoHash);
    // Parsed, so its trackers can be checked (see "local addresses").
    expect(fakeClient.get(infoHash).torrentId).toMatchObject({
      infoHash,
      announce: ["udp://tracker.example:1337"],
    });
  });

  it("adds no extra trackers to a private torrent", async () => {
    const { bytes, infoHash } = makeTorrentFile({
      name: "Private",
      files: [{ path: ["a.mp4"], length: 10 }],
      private: true,
    });

    await torrentService.add({ torrentFile: bytes });

    expect(fakeClient.get(infoHash).options.announce).toEqual([]);
  });

  it.each([
    ["garbage", Buffer.from("definitely not bencode")],
    ["20 bytes (would pass as a raw info hash)", Buffer.alloc(20, 7)],
    ["an empty file", Buffer.alloc(0)],
  ])("rejects %s as a .torrent file", async (_name, bytes) => {
    await expectAppError(
      () => torrentService.add({ torrentFile: bytes }),
      ErrorCode.BadRequest,
      "This isn't a valid .torrent file",
    );
  });
});

describe("the video folder", () => {
  it("refuses to add when it's gone (503), without creating it", async () => {
    const { cacheDir } = getRuntime().config;
    const moved = `${cacheDir}-unplugged`;
    await rename(cacheDir, moved);
    try {
      await expectAppError(
        () => torrentService.add({ magnet: HASH }),
        ErrorCode.ServiceUnavailable,
        "The video folder isn't available. Is the drive connected?",
      );
      expect(existsSync(cacheDir)).toBe(false);
      expect(fakeClient.torrents).toHaveLength(0);
    } finally {
      await rename(moved, cacheDir);
    }
  });

  it("makes its own subfolders in it", async () => {
    await torrentService.add({ magnet: HASH });
    expect(existsSync(cachePaths().torrents)).toBe(true);
    expect(existsSync(cachePaths().playback)).toBe(true);
  });
});

describe("hostile torrents", () => {
  /** A real .torrent built by parse-torrent, with the paths we choose. */
  function craftedTorrent(paths: string[][]): Buffer {
    return Buffer.from(
      toTorrentFile({
        info: {
          name: Buffer.from("Evil"),
          "piece length": 16384,
          pieces: Buffer.alloc(20),
          files: paths.map((path) => ({
            length: 10,
            path: path.map((part) => Buffer.from(part)),
          })),
        },
      }),
    );
  }

  it.each([[["..", "..", "evil.mp4"]], [["ok", "..", "..", "..", ".bashrc"]]])(
    "refuses a .torrent with a path climbing out of its folder (%j)",
    async (path) => {
      await expectAppError(
        () => torrentService.add({ torrentFile: craftedTorrent([path]) }),
        ErrorCode.BadRequest,
        UNSAFE_NAMES_MESSAGE,
      );
      expect(fakeClient.torrents).toHaveLength(0);
    },
  );

  it("accepts the same .torrent with harmless paths", async () => {
    const { created } = await torrentService.add({
      torrentFile: craftedTorrent([["Season 1", "movie.mp4"]]),
    });
    expect(created).toBe(true);
  });

  it("refuses a .torrent with more files than the limit", async () => {
    const paths = Array.from({ length: MAX_TORRENT_FILES + 1 }, (_, i) => [
      `${i}.txt`,
    ]);

    await expectAppError(
      () => torrentService.add({ torrentFile: craftedTorrent(paths) }),
      ErrorCode.BadRequest,
      "This torrent has too many files (10,001). Streamy opens torrents with up to 10,000 files.",
    );
  });

  it("fails a magnet whose metadata has paths climbing out of its folder", async () => {
    await torrentService.add({ magnet: HASH });
    const torrent = fakeClient.get(HASH);
    const bytes = (value: string) => new TextEncoder().encode(value);

    await torrent.receiveMetadata("Evil", [{ path: "Evil/movie.mp4" }], {
      info: {
        name: bytes("Evil"),
        files: [{ path: [bytes(".."), bytes(".."), bytes("movie.mp4")] }],
      },
    });

    expect(torrentService.get(HASH)).toMatchObject({
      status: "error",
      error: UNSAFE_NAMES_MESSAGE,
      files: [],
    });
    expect(torrent.destroyed).toBe(true);
    expect(torrent.destroyOptions).toEqual({ destroyStore: true });
  });

  it("fails a magnet whose metadata has too many files", async () => {
    await torrentService.add({ magnet: HASH });
    const torrent = fakeClient.get(HASH);

    await torrent.receiveMetadata(
      "Huge",
      Array.from({ length: MAX_TORRENT_FILES + 1 }, (_, i) => ({
        path: `Huge/${i}.txt`,
      })),
    );

    expect(torrentService.get(HASH)).toMatchObject({
      status: "error",
      error: expect.stringContaining("too many files") as string,
    });
    expect(torrent.destroyed).toBe(true);
  });

  it("fails a magnet whose files would collide on disk, and deletes its folder", async () => {
    await torrentService.add({ magnet: HASH });
    const torrent = fakeClient.get(HASH);

    await torrent.receiveMetadata("Show", [
      { path: "Show/Subs.srt" },
      { path: "Show/subs.srt" },
    ]);

    expect(torrentService.get(HASH)).toMatchObject({
      status: "error",
      error: UNSAFE_NAMES_MESSAGE,
    });
    expect(torrent.destroyOptions).toEqual({ destroyStore: true });
  });
});

describe("status", () => {
  it("is ready with name, size and files once the metadata is in", async () => {
    const torrent = await addReady();
    torrent.progress = 0.25;
    torrent.downloadSpeed = 1234.6;
    torrent.uploadSpeed = 10;
    torrent.numPeers = 7;
    const [video] = torrent.files;
    if (video) video.progress = 0.5;

    expect(torrentService.get(HASH)).toMatchObject({
      status: "ready",
      name: "Sintel",
      size: 135,
      progress: 0.25,
      downloadSpeed: 1235,
      uploadSpeed: 10,
      peers: 7,
      files: [
        {
          index: 0,
          name: "Sintel.mp4",
          path: "Sintel/Sintel.mp4",
          size: 100,
          kind: "video",
          progress: 0.5,
        },
        {
          index: 1,
          name: "Sintel.en.srt",
          path: "Sintel/Sintel.en.srt",
          size: 35,
          kind: "subtitle",
          progress: 0,
        },
        {
          index: 2,
          name: "readme.txt",
          path: "Sintel/readme.txt",
          size: 0,
          kind: "other",
          progress: 0,
        },
      ],
    });
  });

  it("says 1 for a file that's done (WebTorrent's own count can fall short)", async () => {
    const torrent = await addReady();
    const [video] = torrent.files;
    if (!video) throw new Error("no video");
    video.progress = 0.99;
    video.done = true;

    expect(torrentService.get(HASH).files[0]?.progress).toBe(1);
  });

  it("keeps a failed torrent visible, with a sentence for people", async () => {
    const torrent = await addReady();
    torrent.numPeers = 3;
    const err = Object.assign(
      new Error(
        "ENOSPC: no space left on device, write '/Users/me/Movies/Sintel/Sintel.mp4'",
      ),
      { code: "ENOSPC" },
    );
    torrent.fail(err);

    expect(torrentService.get(HASH)).toMatchObject({
      status: "error",
      error: "Your disk is full.",
      name: "Sintel",
      peers: 0,
      files: [],
    });
  });

  it("never shows WebTorrent's own words", async () => {
    (await addReady()).fail("Cannot read properties of undefined");

    expect(torrentService.get(HASH).error).toBe(
      "Something went wrong with this torrent.",
    );
  });

  it("is checking between the metadata and ready: files listed, not playable yet", async () => {
    await torrentService.add({ magnet: HASH });
    const torrent = fakeClient.get(HASH);
    expect(torrentService.get(HASH).status).toBe("fetching_metadata");

    await torrent.receiveMetadata("Sintel", [{ path: "Sintel/Sintel.mp4" }], {
      checking: true,
    });

    expect(torrentService.get(HASH)).toMatchObject({
      status: "checking",
      name: "Sintel",
      files: [{ name: "Sintel.mp4" }],
    });
    await expectAppError(
      () => torrentService.getFile(HASH, 0),
      ErrorCode.Conflict,
      "Streamy is checking what's already downloaded. Try again in a moment.",
    );

    torrent.finishChecking();
    expect(torrentService.get(HASH).status).toBe("ready");
    expect(torrentService.getFile(HASH, 0).name).toBe("Sintel.mp4");
  });

  it("goes from metadata to ready a moment later, like WebTorrent", async () => {
    await torrentService.add({ magnet: HASH });
    const arriving = fakeClient
      .get(HASH)
      .receiveMetadata("Sintel", [{ path: "Sintel/Sintel.mp4" }]);

    expect(torrentService.get(HASH).status).toBe("checking");
    await arriving;
    expect(torrentService.get(HASH).status).toBe("ready");
  });

  it("says so when WebTorrent stops a torrent on its own", async () => {
    const torrent = await addReady();
    torrent.destroy();

    expect(torrentService.get(HASH)).toMatchObject({
      status: "error",
      error: "The download stopped unexpectedly",
    });
  });

  it("lists the most recently used first", async () => {
    await torrentService.add({ magnet: HASH });
    vi.advanceTimersByTime(1000);
    await torrentService.add({ magnet: OTHER });
    vi.advanceTimersByTime(1000);
    torrentService.touch(HASH);

    expect(torrentService.list().map((torrent) => torrent.infoHash)).toEqual([
      HASH,
      OTHER,
    ]);
    expect(torrentService.list()[0]?.lastActivityAt).toBe(
      "2026-01-01T12:00:02.000Z",
    );
  });

  it("throws NOT_FOUND for an unknown torrent; removing one is fine", async () => {
    await expectAppError(() => torrentService.get(OTHER), ErrorCode.NotFound);
    await expect(torrentService.remove(OTHER)).resolves.toBeUndefined();
  });

  it("ignores touch on an unknown torrent", () => {
    expect(() => {
      torrentService.touch(OTHER);
    }).not.toThrow();
  });
});

describe("onMetadata", () => {
  it("tells listeners what the library keeps, once the metadata is in", async () => {
    const events: TorrentMetadataEvent[] = [];
    const unsubscribe = torrentService.onMetadata((event) =>
      events.push(event),
    );
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`;
    await torrentService.add({ magnet });
    expect(events).toEqual([]);

    const torrent = await addReady(HASH);

    expect(events).toEqual([
      {
        infoHash: HASH,
        name: "Sintel",
        magnet,
        torrentFile: torrent.torrentFile,
        size: 135,
        fileCount: 3,
      },
    ]);
    unsubscribe();
  });

  it("passes the original bytes of a .torrent file, and no magnet", async () => {
    const events: TorrentMetadataEvent[] = [];
    const unsubscribe = torrentService.onMetadata((event) =>
      events.push(event),
    );
    const { bytes, infoHash } = makeTorrentFile({
      name: "Movie",
      files: [{ path: ["movie.mkv"], length: 1000 }],
    });

    await torrentService.add({ torrentFile: bytes });
    await fakeClient
      .get(infoHash)
      .receiveMetadata("Movie", [{ path: "Movie/movie.mkv" }]);

    expect(events[0]).toMatchObject({ infoHash, magnet: null });
    expect(events[0]?.torrentFile).toBe(bytes);
    unsubscribe();
  });

  it("keeps going when a listener throws", async () => {
    const unsubscribe = torrentService.onMetadata(() => {
      throw new Error("listener bug");
    });

    await addReady();

    expect(torrentService.get(HASH).status).toBe("ready");
    unsubscribe();
  });
});

describe("getFile", () => {
  it("describes the file", async () => {
    await addReady();

    expect(torrentService.getFile(HASH, 0)).toMatchObject({
      infoHash: HASH,
      index: 0,
      name: "Sintel.mp4",
      path: "Sintel/Sintel.mp4",
      size: 100,
      kind: "video",
    });
  });

  it("mints a token URL for ffmpeg that reads only this file", async () => {
    await addReady();
    const internal = torrentService.getFile(HASH, 0).mintInternalUrl();

    const match =
      /^http:\/\/127\.0\.0\.1:4321\/internal\/files\/([\w-]{43})$/.exec(
        internal.url,
      );
    expect(match).not.toBeNull();
    const token = match?.[1] ?? "";
    expect(resolveFileToken(token)).toEqual({ infoHash: HASH, fileIndex: 0 });

    internal.revoke();
    expect(resolveFileToken(token)).toBeNull();
  });

  it("throws CONFLICT until the metadata is in, NOT_FOUND for a bad index", async () => {
    await torrentService.add({ magnet: HASH });
    await expectAppError(
      () => torrentService.getFile(HASH, 0),
      ErrorCode.Conflict,
    );

    await fakeClient.get(HASH).receiveMetadata("Sintel", [{ path: "a.mp4" }]);
    await expectAppError(
      () => torrentService.getFile(HASH, 5),
      ErrorCode.NotFound,
    );
    await expectAppError(
      () => torrentService.getFile(OTHER, 0),
      ErrorCode.NotFound,
    );
  });

  it("throws NOT_FOUND (not CONFLICT, which the player retries) for a failed torrent", async () => {
    await torrentService.add({ magnet: HASH });
    fakeClient.get(HASH).fail("Tracker exploded");

    await expectAppError(
      () => torrentService.getFile(HASH, 0),
      ErrorCode.NotFound,
      "This torrent failed: Something went wrong with this torrent.",
    );
  });

  it("reads exactly the asked range", async () => {
    await addReady();
    const file = torrentService.getFile(HASH, 0);

    expect(await text(file.createReadStream({ start: 5, end: 24 }))).toBe(
      "56789012345678901234",
    );
    expect(await text(file.createReadStream({ start: 0, end: 0 }))).toBe("0");
    expect(await text(file.createReadStream({ start: 99, end: 99 }))).toBe("9");
    expect((await text(file.createReadStream())).length).toBe(100);
  });

  it("asks WebTorrent for the first piece only when reading byte 0 alone", async () => {
    const torrent = await addReady();
    const [video] = torrent.files;
    if (!video) throw new Error("no video");

    await text(
      torrentService.getFile(HASH, 0).createReadStream({ start: 0, end: 0 }),
    );

    // `end: 0` would be "the whole file" to WebTorrent.
    expect(video.readRanges).toEqual([{ start: 0, end: 1 }]);
  });

  it("releases the pieces when a read is destroyed (a seek)", async () => {
    const torrent = await addReady();
    const [video] = torrent.files;
    if (!video) throw new Error("no video");
    video.stalled = true;

    const stream = torrentService
      .getFile(HASH, 0)
      .createReadStream({ start: 50, end: 99 });
    stream.resume();
    expect(video.openReads).toBe(1);
    expect(torrentUsage()[0]?.idleMs).toBe(0); // being read = in use

    stream.destroy();
    await new Promise((resolve) => stream.once("close", resolve));

    expect(video.openReads).toBe(0);
  });

  it("rejects a range outside the file", async () => {
    await addReady();
    const file = torrentService.getFile(HASH, 0);

    expect(() => file.createReadStream({ start: 50, end: 100 })).toThrow(
      AppError,
    );
    expect(() => file.createReadStream({ start: 10, end: 5 })).toThrow(
      AppError,
    );
  });

  it("reads small files whole, refusing big ones with 400", async () => {
    await addReady();
    const subtitle = torrentService.getFile(HASH, 1);

    expect((await subtitle.readAll({ maxBytes: 1000 })).toString()).toContain(
      "Hi",
    );
    await expectAppError(
      () => subtitle.readAll({ maxBytes: 10 }),
      ErrorCode.BadRequest,
      /too big/,
    );
    expect(
      (await torrentService.getFile(HASH, 2).readAll({ maxBytes: 10 })).length,
    ).toBe(0);
  });
});

describe("focusFile", () => {
  it("downloads the watched file in the background, and nothing else", async () => {
    const torrent = await addReady();
    const [video, subtitle] = torrent.files;
    subtitle?.select();

    torrentService.focusFile(HASH, 0);

    expect(video?.selected).toBe(true);
    expect(video?.selectedPriority).toBeUndefined(); // the lowest priority
    expect(subtitle?.selected).toBe(false);
  });

  it("switches to another file", async () => {
    const torrent = await addReady();
    torrentService.focusFile(HASH, 0);
    torrentService.focusFile(HASH, 1);

    expect(torrent.files.map((file) => file.selected)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("stops the background download when the disk is full", async () => {
    const torrent = await addReady();
    torrentService.focusFile(HASH, 0);

    stopBackgroundDownload(HASH);
    expect(torrent.files[0]?.selected).toBe(false);

    // Watching again starts it again.
    torrentService.focusFile(HASH, 0);
    expect(torrent.files[0]?.selected).toBe(true);
  });
});

describe("remove", () => {
  it("destroys the torrent with its files, cuts reads, revokes tokens and tells listeners", async () => {
    const torrent = await addReady();
    const [video] = torrent.files;
    if (video) video.stalled = true;
    const stream = torrentService.getFile(HASH, 0).createReadStream();
    stream.resume();
    const closed = new Promise((resolve) => stream.once("close", resolve));
    torrentService.getFile(HASH, 0).mintInternalUrl();
    const removed: [string, TorrentRemoval][] = [];
    const unsubscribe = torrentService.onRemoved((infoHash, removal) =>
      removed.push([infoHash, removal]),
    );

    await torrentService.remove(HASH, { forget: true });
    await closed;

    expect(removed).toEqual([[HASH, { dataDeleted: true, forget: true }]]);
    expect(torrent.destroyed).toBe(true);
    expect(torrent.destroyOptions).toEqual({ destroyStore: true });
    expect(video?.openReads).toBe(0);
    expect(activeFileTokenCount()).toBe(0);
    expect(torrentService.list()).toEqual([]);

    unsubscribe();
    await torrentService.add({ magnet: HASH });
    await torrentService.remove(HASH);
    expect(removed).toHaveLength(1);
  });

  it("deletes the folder of a torrent that isn't active anymore", async () => {
    const dir = join(cachePaths().torrents, OTHER);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "movie.mkv"), "bytes");
    const removed: [string, TorrentRemoval][] = [];
    const unsubscribe = torrentService.onRemoved((infoHash, removal) =>
      removed.push([infoHash, removal]),
    );

    await torrentService.remove(OTHER);

    expect(existsSync(dir)).toBe(false);
    expect(removed).toEqual([[OTHER, { dataDeleted: true, forget: false }]]);
    // Nothing left: nothing to tell, unless the library should forget it.
    await torrentService.remove(OTHER);
    expect(removed).toHaveLength(1);
    await torrentService.remove(OTHER, { forget: true });
    expect(removed[1]).toEqual([OTHER, { dataDeleted: false, forget: true }]);
    unsubscribe();
  });

  it("keeps going when a listener throws", async () => {
    await torrentService.add({ magnet: HASH });
    const unsubscribe = torrentService.onRemoved(() => {
      throw new Error("listener bug");
    });

    await torrentService.remove(HASH);

    expect(torrentService.list()).toEqual([]);
    unsubscribe();
  });
});

describe("stop", () => {
  it("stops the torrent but keeps its data", async () => {
    const torrent = await addReady();
    const removed: [string, TorrentRemoval][] = [];
    const unsubscribe = torrentService.onRemoved((infoHash, removal) =>
      removed.push([infoHash, removal]),
    );

    await torrentService.stop(HASH);

    expect(torrent.destroyed).toBe(true);
    expect(torrent.destroyOptions).toEqual({ destroyStore: false });
    expect(removed).toEqual([[HASH, { dataDeleted: false, forget: false }]]);
    expect(torrentService.list()).toEqual([]);
    // Unknown: nothing to do.
    await torrentService.stop(OTHER);
    unsubscribe();
  });
});

describe("torrentUsage", () => {
  it("reports idle time and bytes downloaded", async () => {
    const torrent = await addReady();
    torrent.downloaded = 4096;
    vi.advanceTimersByTime(90_000);

    expect(torrentUsage()).toEqual([
      {
        infoHash: HASH,
        idleMs: 90_000,
        lastActivityAt: Date.parse("2026-01-01T12:00:00Z"),
        downloaded: 4096,
        failed: false,
      },
    ]);
  });
});

describe("resume records (fast resume)", () => {
  const NOON = Date.parse("2026-01-01T12:00:00Z");

  afterEach(async () => {
    // Stopped torrents leave their record and data: start clean.
    for (const infoHash of [HASH, OTHER]) {
      await torrentService.remove(infoHash, { forget: true });
    }
  });

  it("saves which pieces are on disk when a torrent stops", async () => {
    const torrent = await addReady();
    const bitfield = torrent.bitfield?.buffer ?? new Uint8Array(0);
    bitfield[0] = 0b1000_0000; // its only piece
    vi.advanceTimersByTime(5000);
    torrentService.touch(HASH);

    await torrentService.stop(HASH);

    expect(await readTorrentRecord(cacheDir, HASH)).toEqual({
      name: "Sintel",
      addedAt: NOON,
      lastUsedAt: NOON + 5000,
      bitfield: Buffer.from([0x80]),
    });
  });

  it("saves nothing without metadata, after a failure, or when asked not to", async () => {
    await torrentService.add({ magnet: HASH });
    await torrentService.stop(HASH);
    expect(await readTorrentRecord(cacheDir, HASH)).toBeNull();

    (await addReady()).fail("Disk exploded");
    await torrentService.stop(HASH);
    expect(await readTorrentRecord(cacheDir, HASH)).toBeNull();

    await addReady();
    await torrentService.stop(HASH, { saveRecord: false });
    expect(await readTorrentRecord(cacheDir, HASH)).toBeNull();
  });

  it("passes the saved pieces back when re-added, and keeps when it was first stored", async () => {
    const firstStored = NOON - 86_400_000;
    await mkdir(torrentDataDir(cacheDir, HASH), { recursive: true });
    await writeTorrentRecord(cacheDir, HASH, {
      name: "Sintel",
      addedAt: firstStored,
      lastUsedAt: firstStored,
      bitfield: Uint8Array.from([0x80]),
    });

    await addReady();
    expect(fakeClient.get(HASH).options.bitfield).toEqual(Buffer.from([0x80]));
    // When it became active in this run, not when it was first stored.
    expect(torrentService.get(HASH).addedAt).toBe("2026-01-01T12:00:00.000Z");

    await torrentService.stop(HASH);
    expect((await readTorrentRecord(cacheDir, HASH))?.addedAt).toBe(
      firstStored,
    );
  });

  it("ignores a record whose data folder is gone", async () => {
    await writeTorrentRecord(cacheDir, HASH, {
      name: "Sintel",
      addedAt: NOON,
      lastUsedAt: NOON,
      bitfield: Uint8Array.from([0xff]),
    });

    await torrentService.add({ magnet: HASH });

    expect(fakeClient.get(HASH).options).not.toHaveProperty("bitfield");
  });

  it("deletes the record with the data, active or stored", async () => {
    await addReady();
    await torrentService.stop(HASH);
    await mkdir(torrentDataDir(cacheDir, HASH), { recursive: true });
    expect(existsSync(torrentRecordFile(cacheDir, HASH))).toBe(true);

    // Stored: only its record and folder are left.
    await torrentService.remove(HASH);
    expect(existsSync(torrentRecordFile(cacheDir, HASH))).toBe(false);
    expect(existsSync(torrentDataDir(cacheDir, HASH))).toBe(false);

    // Active.
    await addReady();
    await torrentService.stop(HASH);
    await addReady();
    await torrentService.remove(HASH);
    expect(existsSync(torrentRecordFile(cacheDir, HASH))).toBe(false);
  });

  it("saves every active torrent's record at shutdown", async () => {
    await addReady(HASH);
    await addReady(OTHER);

    await saveTorrentRecords();

    expect((await readTorrentRecord(cacheDir, HASH))?.name).toBe("Sintel");
    expect((await readTorrentRecord(cacheDir, OTHER))?.name).toBe("Sintel");
  });
});

describe("opening from saved metadata", () => {
  const saved = makeTorrentFile({
    name: "Movie",
    files: [{ path: ["movie.mkv"], length: 1000 }],
  });
  const lookup = (infoHash: string): SavedTorrent | null =>
    infoHash === saved.infoHash
      ? { metadata: saved.bytes, magnet: null }
      : null;

  afterEach(async () => {
    await torrentService.remove(saved.infoHash, { forget: true });
  });

  it("starts from the saved .torrent, with the magnet's trackers and peers", async () => {
    const magnet = `magnet:?xt=urn:btih:${saved.infoHash}&tr=udp%3A%2F%2Ftracker.extra.example%3A1&x.pe=203.0.113.5:6881`;
    const events: TorrentMetadataEvent[] = [];
    const unsubscribe = torrentService.onMetadata((e) => events.push(e));

    const { created } = await torrentService.add({ magnet }, { saved: lookup });

    expect(created).toBe(true);
    const torrent = fakeClient.get(saved.infoHash);
    expect(torrent.torrentId).toMatchObject({
      infoHash: saved.infoHash,
      announce: ["udp://tracker.example:1337", "udp://tracker.extra.example:1"],
      peerAddresses: ["203.0.113.5:6881"],
    });
    expect(torrent.torrentId).toHaveProperty("info");

    await torrent.receiveMetadata("Movie", [{ path: "Movie/movie.mkv" }]);
    expect(events[0]?.magnet).toBe(magnet);
    expect(events[0]?.torrentFile).toEqual(saved.bytes);
    unsubscribe();
  });

  it("keeps the saved magnet when opened by a bare info hash", async () => {
    const events: TorrentMetadataEvent[] = [];
    const unsubscribe = torrentService.onMetadata((e) => events.push(e));

    await torrentService.add({ magnet: saved.infoHash }, { saved: lookup });
    await fakeClient
      .get(saved.infoHash)
      .receiveMetadata("Movie", [{ path: "Movie/movie.mkv" }]);

    expect(events[0]?.magnet).toBeNull();
    unsubscribe();
  });

  it("gives a bare info hash the saved magnet's trackers, web seeds and peers", async () => {
    const savedMagnet = `magnet:?xt=urn:btih:${saved.infoHash}&dn=Movie&tr=udp%3A%2F%2Ft.example%3A1&ws=https%3A%2F%2Fseed.example%2Fm&x.pe=203.0.113.5:6881&x.pe=192.168.1.10:6881`;

    // With the metadata saved too: merged into it.
    await torrentService.add(
      { magnet: saved.infoHash },
      { saved: () => ({ metadata: saved.bytes, magnet: savedMagnet }) },
    );
    expect(fakeClient.get(saved.infoHash).torrentId).toMatchObject({
      announce: ["udp://tracker.example:1337", "udp://t.example:1"],
      urlList: ["https://seed.example/m"],
      // The LAN peer is left out (it may have been saved by an older Streamy).
      peerAddresses: ["203.0.113.5:6881"],
    });
    await torrentService.stop(saved.infoHash);

    // Only the magnet: started from it.
    await torrentService.add(
      { magnet: saved.infoHash },
      { saved: () => ({ metadata: null, magnet: savedMagnet }) },
    );
    expect(fakeClient.get(saved.infoHash).torrentId).toBe(
      `magnet:?xt=urn:btih:${saved.infoHash}&dn=Movie&tr=udp%3A%2F%2Ft.example%3A1&ws=https%3A%2F%2Fseed.example%2Fm&x.pe=203.0.113.5:6881`,
    );
  });

  it("re-opens what it saved from the fake's realistic .torrent", async () => {
    const files = [{ path: "Clip/clip.mp4", length: 40_000 }];
    const { infoHash } = torrentFileFor("Clip", files);
    const kept = new Map<string, Uint8Array>();
    const unsubscribe = torrentService.onMetadata((event) =>
      kept.set(event.infoHash, event.torrentFile),
    );
    await torrentService.add({ magnet: infoHash });
    await fakeClient
      .get(infoHash)
      .receiveMetadata("Clip", [
        { path: "Clip/clip.mp4", data: Buffer.alloc(40_000) },
      ]);
    await torrentService.stop(infoHash);

    await torrentService.add(
      { magnet: infoHash },
      {
        saved: (hash) => ({ metadata: kept.get(hash) ?? null, magnet: null }),
      },
    );

    expect(fakeClient.get(infoHash).torrentId).toMatchObject({
      infoHash,
      files: [{ path: "Clip/clip.mp4", length: 40_000 }],
    });
    unsubscribe();
    await torrentService.remove(infoHash, { forget: true });
  });

  it("doesn't look anything up for a torrent that's already active", async () => {
    await torrentService.add({ magnet: saved.infoHash });
    const spy = vi.fn(lookup);

    const again = await torrentService.add(
      { magnet: saved.infoHash },
      { saved: spy },
    );

    expect(again.created).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing saved", () => null],
    [
      "another torrent's metadata",
      () => ({
        metadata: makeTorrentFile({
          name: "X",
          files: [{ path: ["x"], length: 1 }],
        }).bytes,
        magnet: null,
      }),
    ],
    [
      "garbage",
      () => ({ metadata: Buffer.from("not bencode"), magnet: "nonsense" }),
    ],
    [
      "a failing library",
      () => {
        throw new Error("library closed");
      },
    ],
  ])("falls back to the magnet with %s", async (_name, lookUp) => {
    await torrentService.add({ magnet: saved.infoHash }, { saved: lookUp });

    expect(fakeClient.get(saved.infoHash).torrentId).toBe(
      `magnet:?xt=urn:btih:${saved.infoHash}`,
    );
  });
});

describe("admit", () => {
  it("can refuse a torrent that isn't active, never one that is", async () => {
    const refuse = () => {
      throw new AppError(ErrorCode.ServiceUnavailable, "Disk full");
    };

    await expectAppError(
      () => torrentService.add({ magnet: HASH }, { admit: refuse }),
      ErrorCode.ServiceUnavailable,
      "Disk full",
    );
    expect(fakeClient.torrents).toHaveLength(0);

    await torrentService.add({ magnet: HASH });
    const again = await torrentService.add({ magnet: HASH }, { admit: refuse });
    expect(again.created).toBe(false);
  });

  it("says whether Streamy knows it: its data on disk, or the library", async () => {
    const known: boolean[] = [];
    const admit = (_infoHash: string, isKnown: boolean) => {
      known.push(isKnown);
    };

    await torrentService.add({ magnet: HASH }, { admit });
    await torrentService.stop(HASH);
    await mkdir(torrentDataDir(cacheDir, HASH), { recursive: true });
    await torrentService.add({ magnet: HASH }, { admit });
    await torrentService.add(
      { magnet: OTHER },
      { admit, saved: () => ({ metadata: null, magnet: null }) },
    );

    expect(known).toEqual([false, true, true]);
    await torrentService.remove(HASH, { forget: true });
  });
});

describe("opening a failed torrent again", () => {
  it("starts it fresh: its data and the library stay, no record is written", async () => {
    const torrent = await addReady();
    const dir = torrentDataDir(cacheDir, HASH);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "piece"), "kept");
    torrent.fail(
      Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }),
    );
    expect(torrentService.get(HASH).status).toBe("error");
    const removed: [string, TorrentRemoval][] = [];
    const unsubscribe = torrentService.onRemoved((infoHash, removal) =>
      removed.push([infoHash, removal]),
    );

    const again = await torrentService.add({ magnet: HASH });

    expect(again).toMatchObject({
      created: true,
      torrent: { status: "fetching_metadata", error: null },
    });
    expect(fakeClient.torrents.filter((t) => t.infoHash === HASH)).toHaveLength(
      2,
    );
    expect(removed).toEqual([[HASH, { dataDeleted: false, forget: false }]]);
    expect(existsSync(join(dir, "piece"))).toBe(true);
    expect(existsSync(torrentRecordFile(cacheDir, HASH))).toBe(false);
    unsubscribe();
    await torrentService.remove(HASH);
  });

  it("also for a hostile torrent: it fails again (its folder deleted first)", async () => {
    await torrentService.add({ magnet: HASH });
    await fakeClient
      .get(HASH)
      .receiveMetadata("Show", [
        { path: "Show/a?.mkv" },
        { path: "Show/a*.mkv" },
      ]);

    const again = await torrentService.add({ magnet: HASH });
    await fakeClient
      .get(HASH)
      .receiveMetadata("Show", [
        { path: "Show/a?.mkv" },
        { path: "Show/a*.mkv" },
      ]);

    expect(again.created).toBe(true);
    expect(torrentService.get(HASH).error).toBe(UNSAFE_NAMES_MESSAGE);
  });
});

describe("peers named in a magnet", () => {
  it("connects a torrent that's already active to a new magnet's peers", async () => {
    const torrent = await addReady();

    await torrentService.add({
      magnet: `magnet:?xt=urn:btih:${HASH}&x.pe=203.0.113.5:6881&x.pe=10.0.0.2:6881`,
    });

    expect(torrent.peersAdded).toEqual(["203.0.113.5:6881"]);
  });
});

describe("local addresses (a web page can hand Streamy a magnet)", () => {
  afterEach(() => {
    updateTuning({ allowLocalAddresses: false });
  });

  it("drops xs, as and every local tracker, web seed and peer", async () => {
    const magnet =
      `magnet:?xt=urn:btih:${HASH}&dn=Sintel` +
      "&xs=http%3A%2F%2F192.168.1.1%2Freboot&as=http%3A%2F%2Fexample.com%2Fa" +
      "&tr=http%3A%2F%2F127.0.0.1%3A8080%2Fannounce&tr=udp%3A%2F%2Ftracker.example.com%3A80" +
      "&ws=http%3A%2F%2Fnas.local%2Fmovie&x.pe=[::1]:6881&x.pe=198.51.100.7:6881";

    await torrentService.add({ magnet });

    expect(fakeClient.get(HASH).torrentId).toBe(
      `magnet:?xt=urn:btih:${HASH}&dn=Sintel&tr=udp%3A%2F%2Ftracker.example.com%3A80&x.pe=198.51.100.7:6881`,
    );
  });

  it("drops local trackers and web seeds from a .torrent file", async () => {
    const { bytes, infoHash } = makeTorrentFile({
      name: "Movie",
      files: [{ path: ["movie.mkv"], length: 10 }],
      announce: ["http://192.168.0.1/announce", "udp://tracker.example.com:80"],
      urlList: ["http://localhost:8080/movie", "https://seed.example.com/m"],
    });

    await torrentService.add({ torrentFile: bytes });

    expect(fakeClient.get(infoHash).torrentId).toMatchObject({
      announce: ["udp://tracker.example.com:80"],
      urlList: ["https://seed.example.com/m"],
    });
  });

  it("keeps them in test mode (the e2e seeder is on 127.0.0.1)", async () => {
    updateTuning({ allowLocalAddresses: true });
    const magnet = `magnet:?xt=urn:btih:${HASH}&x.pe=127.0.0.1:6881`;

    await torrentService.add({ magnet });

    expect(fakeClient.get(HASH).torrentId).toBe(magnet);
  });
});

describe("pausing downloads (disk almost full)", () => {
  afterEach(() => {
    pauseDownloads(false);
  });

  it("holds peers back and drops background downloads until resumed", async () => {
    const torrent = await addReady();
    const [video, subtitle] = torrent.files;
    torrentService.focusFile(HASH, 0);
    expect(video?.selected).toBe(true);

    pauseDownloads(true);
    expect(clientState.downloadsPaused).toBe(true);
    expect(video?.selected).toBe(false);

    // Watching another file meanwhile doesn't start a download either.
    torrentService.focusFile(HASH, 1);
    expect(subtitle?.selected).toBe(false);

    pauseDownloads(false);
    expect(clientState.downloadsPaused).toBe(false);
    expect(subtitle?.selected).toBe(true);
    expect(video?.selected).toBe(false);
  });

  it("keeps peer connections while paused, and reconnects to its peers after", async () => {
    const torrent = await addReady();
    const outgoing = torrent.connectWire("tcpOutgoing", "203.0.113.5:6881");
    const incoming = torrent.connectWire("tcpIncoming", "198.51.100.7:51234");
    const webSeed = torrent.connectWire("webSeed");
    webSeed.timeoutMs = -1; // WebTorrent sets none on web seeds

    pauseDownloads(true);
    // Answers are held back: waiting for them mustn't drop the peer.
    expect([outgoing.timeoutMs, incoming.timeoutMs]).toEqual([0, 0]);
    expect(webSeed.timeoutMs).toBe(-1);
    // A peer that connects meanwhile too.
    const late = torrent.connectWire("utpOutgoing", "203.0.113.9:6881");
    expect(late.timeoutMs).toBe(0);

    pauseDownloads(false);
    expect([outgoing.timeoutMs, incoming.timeoutMs, late.timeoutMs]).toEqual([
      30_000, 30_000, 30_000,
    ]);
    // The ones we connected to (an incoming peer's port is its own).
    expect(torrent.peersAdded).toEqual([
      "203.0.113.5:6881",
      "203.0.113.9:6881",
    ]);
    expect(torrent.trackerUpdates).toBe(1);
  });

  it("reconnects to the magnet's peers too, even if they never answered", async () => {
    await torrentService.add({
      magnet: `magnet:?xt=urn:btih:${HASH}&x.pe=203.0.113.5:6881`,
    });

    pauseDownloads(true);
    pauseDownloads(false);

    expect(fakeClient.get(HASH).peersAdded).toEqual(["203.0.113.5:6881"]);
  });
});

describe("saving the resume record while it downloads", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await torrentService.remove(HASH, { forget: true });
  });

  /** Lets a queued save write its file (real disk I/O, no timers). */
  const settle = settleAllTorrents;

  it("saves it a minute after pieces come in, and only when they did", async () => {
    const torrent = await addReady();
    torrent.verifyPiece(0);
    await vi.advanceTimersByTimeAsync(RECORD_SAVE_MS - 1);
    await settle();
    expect(await readTorrentRecord(cacheDir, HASH)).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect((await readTorrentRecord(cacheDir, HASH))?.bitfield).toEqual(
      Buffer.from([0x80]),
    );

    // Nothing new: nothing written.
    await rm(torrentRecordFile(cacheDir, HASH));
    await vi.advanceTimersByTimeAsync(5 * RECORD_SAVE_MS);
    await settle();
    expect(existsSync(torrentRecordFile(cacheDir, HASH))).toBe(false);
  });

  it("saves it at once when the torrent is complete", async () => {
    const torrent = await addReady();
    torrent.verifyPiece(0);

    torrent.complete();
    await settle();

    expect((await readTorrentRecord(cacheDir, HASH))?.bitfield).toEqual(
      Buffer.from([0x80]),
    );
  });

  it("doesn't save while it's still checking the data on disk", async () => {
    await torrentService.add({ magnet: HASH });
    const torrent = fakeClient.get(HASH);
    await torrent.receiveMetadata("Sintel", [{ path: "Sintel/a.mp4" }], {
      checking: true,
    });
    torrent.verifyPiece(0);

    await vi.advanceTimersByTimeAsync(RECORD_SAVE_MS);
    await settle();

    expect(await readTorrentRecord(cacheDir, HASH)).toBeNull();
  });

  it("never writes it after the torrent was deleted", async () => {
    const torrent = await addReady();
    torrent.verifyPiece(0);

    await torrentService.remove(HASH);
    await vi.advanceTimersByTimeAsync(RECORD_SAVE_MS);
    await settle();

    expect(existsSync(torrentRecordFile(cacheDir, HASH))).toBe(false);
  });
});

describe("hasUnfinishedTorrents and isActive", () => {
  it("is true while an active torrent still has pieces to get", async () => {
    expect(hasUnfinishedTorrents()).toBe(false);
    const torrent = await addReady();
    expect(hasUnfinishedTorrents()).toBe(true);
    expect(torrentService.isActive(HASH)).toBe(true);
    expect(torrentService.isActive(OTHER)).toBe(false);

    torrent.done = true;
    expect(hasUnfinishedTorrents()).toBe(false);
  });

  it("doesn't count a failed torrent", async () => {
    (await addReady()).fail("Tracker exploded");
    expect(hasUnfinishedTorrents()).toBe(false);
  });
});

describe("changing the video folder", () => {
  it("puts new torrents in the new one; running ones stay, and save their record where they ran", async () => {
    const oldDir = getRuntime().config.cacheDir;
    const newDir = join(dirname(oldDir), "new-videos");
    await makeVideoFolder(newDir);
    await addReady(HASH);
    updateConfig({ ...getRuntime().config, cacheDir: newDir });
    try {
      await addReady(OTHER);
      expect(fakeClient.get(OTHER).options.path).toBe(
        torrentDataDir(newDir, OTHER),
      );
      expect(fakeClient.get(HASH).options.path).toBe(
        torrentDataDir(oldDir, HASH),
      );

      await torrentService.stop(HASH);

      expect(existsSync(torrentRecordFile(oldDir, HASH))).toBe(true);
      expect(existsSync(torrentRecordFile(newDir, HASH))).toBe(false);
    } finally {
      updateConfig({ ...getRuntime().config, cacheDir: oldDir });
      await torrentService.remove(HASH, { forget: true });
    }
  });
});
