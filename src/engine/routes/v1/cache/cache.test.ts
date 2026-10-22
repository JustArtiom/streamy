import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import request from "supertest";
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
import { ENGINE_SECRET_HEADER } from "../../../../shared/engine-protocol";
import { CACHE_MARKER } from "../../../../shared/video-folder";
import { torrentDataDir, torrentRecordFile } from "../../../cache";
import { getRuntime } from "../../../config";
import { createApp } from "../../../http/app";
import { ErrorCode } from "../../../http/errors";
import { setEngineServices } from "../../../services";
import { fakeClient } from "../../../test/fake-torrent-client";
import { TEST_SECRET, useTestRuntime } from "../../../test/runtime";
import { type TestServices, useTestServices } from "../../../test/services";
import { torrentService } from "../../../torrents/service";
import { DISK_FULL_MESSAGE } from "../guards";

const clientState = vi.hoisted(() => ({ downloadsPaused: false }));

vi.mock("../../../torrents/client", async () => {
  const { fakeClient } = await import("../../../test/fake-torrent-client");
  return {
    getTorrentClient: () => fakeClient,
    destroyTorrentClient: () => Promise.resolve(),
    setDownloadsPaused: (paused: boolean) => {
      clientState.downloadsPaused = paused;
    },
  };
});

const GB = 1024 ** 3;
const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
/** A different info hash for each number. */
const hash = (n: number) => n.toString(16).padStart(40, "0");

const app = createApp({ secret: TEST_SECRET });
const api = {
  get: (url: string) =>
    request(app).get(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
  post: (url: string) =>
    request(app).post(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
};
async function addReady(infoHash = HASH) {
  await api.post("/v1/torrents").send({ magnet: infoHash });
  await fakeClient
    .get(infoHash)
    .receiveMetadata("Sintel", [
      { path: "Sintel/Sintel.mp4", data: Buffer.alloc(100) },
    ]);
}

let cleanup: () => Promise<void>;
let cacheDir: string;
let services: TestServices;

beforeAll(async () => {
  ({ cleanup, cacheDir } = await useTestRuntime());
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  services = useTestServices();
});

afterEach(async () => {
  for (const { infoHash } of torrentService.list()) {
    await torrentService.remove(infoHash);
  }
  fakeClient.torrents = [];
  await services.teardown();
});

describe("GET /v1/cache", () => {
  it("describes the folder for Settings → Storage", async () => {
    getRuntime().config.cacheLimitBytes = 5 * GB;
    const res = await api.get("/v1/cache");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dir: cacheDir,
      exists: true,
      limitBytes: 5 * GB,
      lowDiskSpace: false,
    });
    expect(res.body.usedBytes).toBeGreaterThanOrEqual(0);
    expect(res.body.freeBytes).toBeGreaterThan(0);
    getRuntime().config.cacheLimitBytes = null;
  });

  it("says the disk is low while downloads are paused", async () => {
    await services.setFreeSpace(0.5 * GB);
    expect((await api.get("/v1/cache")).body.lowDiskSpace).toBe(true);
  });
});

describe("POST /v1/cache/clear", () => {
  it("stops every torrent, then deletes the videos (the library stays)", async () => {
    await addReady();
    const torrent = fakeClient.get(HASH);
    const stored = torrentDataDir(cacheDir, hash(7));
    mkdirSync(stored, { recursive: true });
    writeFileSync(join(stored, "movie.mkv"), "bytes");

    const res = await api.post("/v1/cache/clear");

    expect(res.status).toBe(204);
    expect(torrent.destroyed).toBe(true);
    expect(torrentService.list()).toEqual([]);
    expect(readdirSync(join(cacheDir, "torrents"))).toEqual([]); // no records either
    expect(existsSync(join(cacheDir, CACHE_MARKER))).toBe(true);
    expect(services.library.getTorrent(HASH)?.name).toBe("Sintel");
  });

  it("answers 409 for a folder that isn't Streamy's", async () => {
    rmSync(join(cacheDir, CACHE_MARKER));
    try {
      const res = await api.post("/v1/cache/clear");
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(
        "This doesn't look like Streamy's video folder, so nothing was deleted.",
      );
    } finally {
      writeFileSync(join(cacheDir, CACHE_MARKER), "test\n");
    }
  });

  it("answers 503 outside a running engine", async () => {
    setEngineServices(null);
    expect((await api.post("/v1/cache/clear")).status).toBe(503);
  });

  it("refuses new torrents while it clears", async () => {
    let during: request.Response | null = null;
    await services.cachePolicy.clear(async () => {
      during = await api.post("/v1/torrents").send({ magnet: HASH });
    });
    expect(during).toMatchObject({ status: 503 });
  });
});

describe("when the disk is almost full", () => {
  it("pauses downloads, says so in /v1/health, and refuses new torrents only", async () => {
    await addReady();
    // Known to the library (opened before), stopped since.
    await addReady(hash(2));
    await torrentService.stop(hash(2));
    await services.setFreeSpace(0.5 * GB);

    expect(clientState.downloadsPaused).toBe(true);
    expect((await api.get("/v1/health")).body.lowDiskSpace).toBe(true);

    const added = await api.post("/v1/torrents").send({ magnet: hash(1) });
    expect(added.status).toBe(503);
    expect(added.body.error).toMatchObject({
      code: ErrorCode.ServiceUnavailable,
      message: DISK_FULL_MESSAGE,
    });
    // One that's open already is fine, and so is one Streamy knows (what's
    // downloaded of it can be watched; nothing more downloads).
    expect((await api.post("/v1/torrents").send({ magnet: HASH })).status).toBe(
      200,
    );
    expect(
      (await api.post("/v1/torrents").send({ magnet: hash(2) })).status,
    ).toBe(201);
    expect(clientState.downloadsPaused).toBe(true);

    await services.setFreeSpace(2 * GB);
    expect(clientState.downloadsPaused).toBe(false);
    expect((await api.get("/v1/health")).body.lowDiskSpace).toBe(false);
  });

  it("makes room by deleting stored videos, oldest first, never an active one", async () => {
    await addReady();
    for (const n of [7, 8]) {
      const stored = torrentDataDir(cacheDir, hash(n));
      mkdirSync(stored, { recursive: true });
      writeFileSync(join(stored, "movie.mkv"), "bytes");
    }
    await services.setFreeSpace(0.5 * GB);

    const run = await services.cachePolicy.run();

    expect(run).toMatchObject({
      status: "done",
      evicted: [hash(7), hash(8)],
    });
    expect(readdirSync(join(cacheDir, "torrents"))).toEqual([]);
    expect(torrentService.isActive(HASH)).toBe(true);
  });
});

describe("at most 5 active torrents", () => {
  it("adding a 6th stops the least recently used one (its data stays)", async () => {
    for (let n = 1; n <= 6; n++) {
      await addReady(hash(n));
      torrentService.touch(hash(n));
    }

    // Stopped like an idle one: data kept, resume record saved.
    await vi.waitFor(() => {
      expect(existsSync(torrentRecordFile(cacheDir, hash(1)))).toBe(true);
    });
    expect(torrentService.isActive(hash(1))).toBe(false);
    expect(torrentService.list()).toHaveLength(5);
    expect(fakeClient.get(hash(1)).destroyOptions).toEqual({
      destroyStore: false,
    });
    await torrentService.remove(hash(1));
  });
});
