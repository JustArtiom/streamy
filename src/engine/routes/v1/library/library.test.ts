import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
import { createApp } from "../../../http/app";
import { ErrorCode } from "../../../http/errors";
import { setEngineServices } from "../../../services";
import {
  fakeClient,
  makeTorrentFile,
  torrentFileFor,
} from "../../../test/fake-torrent-client";
import { TEST_SECRET, useTestRuntime } from "../../../test/runtime";
import { type TestServices, useTestServices } from "../../../test/services";
import { torrentService } from "../../../torrents/service";

vi.mock("../../../torrents/client", async () => {
  const { fakeClient } = await import("../../../test/fake-torrent-client");
  return {
    getTorrentClient: () => fakeClient,
    destroyTorrentClient: () => Promise.resolve(),
    setDownloadsPaused: () => undefined,
  };
});

const app = createApp({ secret: TEST_SECRET });
const api = {
  get: (url: string) =>
    request(app).get(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
  put: (url: string) =>
    request(app).put(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
  post: (url: string) =>
    request(app).post(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
  delete: (url: string) =>
    request(app).delete(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
};

/** A real .torrent: its saved copy tells the file names when it's stopped. */
const MOVIE = makeTorrentFile({
  name: "Movie",
  files: [
    { path: ["movie.mkv"], length: 1000 },
    { path: ["movie.en.srt"], length: 10 },
  ],
});
const UNKNOWN = "c".repeat(40);

/** Opens MOVIE like the UI does (a .torrent file), metadata and all. */
async function openMovie() {
  await api
    .post("/v1/torrents/file")
    .set("Content-Type", "application/x-bittorrent")
    .send(MOVIE.bytes)
    .expect(201);
  await fakeClient.get(MOVIE.infoHash).receiveMetadata("Movie", [
    { path: "Movie/movie.mkv", data: Buffer.alloc(1000) },
    { path: "Movie/movie.en.srt", data: Buffer.alloc(10) },
  ]);
}

const progressUrl = (index: number, hash = MOVIE.infoHash) =>
  `/v1/library/${hash}/files/${index}`;

let cleanup: () => Promise<void>;
let services: TestServices;

beforeAll(async () => {
  ({ cleanup } = await useTestRuntime());
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
  await torrentService.remove(MOVIE.infoHash, { forget: true });
  fakeClient.torrents = [];
  await services.teardown();
});

describe("GET /v1/library", () => {
  it("is empty at first", async () => {
    const res = await api.get("/v1/library");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ continueWatching: [], recent: [] });
  });

  it("shows an opened torrent in Recent, active while it runs", async () => {
    await openMovie();

    const recent = (await api.get("/v1/library")).body.recent;
    expect(recent).toEqual([
      expect.objectContaining({
        infoHash: MOVIE.infoHash,
        name: "Movie",
        size: 1010,
        active: true,
      }),
    ]);

    await torrentService.stop(MOVIE.infoHash);
    expect((await api.get("/v1/library")).body.recent[0].active).toBe(false);
  });

  it("shows Continue watching, with a thumbnail URL once the thumbnail exists", async () => {
    await openMovie();
    await api.put(progressUrl(0)).send({ position: 40, duration: 600 });

    const before = (await api.get("/v1/library")).body.continueWatching;
    expect(before).toEqual([
      expect.objectContaining({
        infoHash: MOVIE.infoHash,
        fileIndex: 0,
        fileName: "movie.mkv",
        torrentName: "Movie",
        position: 40,
        thumbnailUrl: null,
      }),
    ]);

    const path = services.library.thumbnailPath(MOVIE.infoHash, 0);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const after = (await api.get("/v1/library")).body.continueWatching;
    expect(after[0].thumbnailUrl).toBe(
      `/v1/library/${MOVIE.infoHash}/files/0/thumbnail`,
    );
  });

  it("answers 503 outside a running engine", async () => {
    setEngineServices(null);
    const res = await api.get("/v1/library");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe(ErrorCode.ServiceUnavailable);
  });

  it("answers 503 when the library is closed", async () => {
    services.library.close();
    expect((await api.get("/v1/library")).status).toBe(503);
  });
});

describe("GET /v1/library/:infoHash", () => {
  it("shows the torrent and its saved positions", async () => {
    await openMovie();
    await api.put(progressUrl(1)).send({ position: 5, duration: null });

    const res = await api.get(`/v1/library/${MOVIE.infoHash.toUpperCase()}`);

    expect(res.status).toBe(200);
    expect(res.body.torrent).toMatchObject({
      infoHash: MOVIE.infoHash,
      active: true,
    });
    expect(res.body.torrent).not.toHaveProperty("metadata");
    expect(res.body.progress).toEqual([
      expect.objectContaining({ fileIndex: 1, position: 5, duration: null }),
    ]);
  });

  it("answers 404 for a torrent it doesn't know, 400 for a bad hash", async () => {
    expect((await api.get(`/v1/library/${UNKNOWN}`)).status).toBe(404);
    expect((await api.get("/v1/library/nope")).status).toBe(400);
  });
});

describe("PUT /v1/library/:infoHash/files/:fileIndex", () => {
  it("saves a position (the file name comes from the torrent) and asks for a thumbnail", async () => {
    await openMovie();

    const res = await api.put(progressUrl(0)).send({
      position: 120,
      duration: 600,
      audioTrack: 1,
      subtitle: "file:1",
    });

    expect(res.status).toBe(200);
    expect(res.body.progress).toMatchObject({
      infoHash: MOVIE.infoHash,
      fileIndex: 0,
      fileName: "movie.mkv",
      position: 120,
      duration: 600,
      audioTrack: 1,
      subtitle: "file:1",
      watched: false,
    });
    expect(services.considered).toEqual([
      { infoHash: MOVIE.infoHash, fileIndex: 0, position: 120 },
    ]);
  });

  it("marks as watched, and back", async () => {
    await openMovie();
    const watched = await api
      .put(progressUrl(0))
      .send({ position: 10, duration: 600, watched: true });
    expect(watched.body.progress.watched).toBe(true);

    const unwatched = await api
      .put(progressUrl(0))
      .send({ position: 10, duration: 600, watched: false });
    expect(unwatched.body.progress.watched).toBe(false);
  });

  it("knows the file names from the saved metadata once the torrent stopped", async () => {
    await openMovie();
    await torrentService.stop(MOVIE.infoHash);

    const res = await api
      .put(progressUrl(1))
      .send({ position: 3, duration: null });

    expect(res.status).toBe(200);
    expect(res.body.progress.fileName).toBe("movie.en.srt");
  });

  it("answers 404 for a file past the end, or a torrent it doesn't know", async () => {
    await openMovie();
    const past = await api
      .put(progressUrl(2))
      .send({ position: 3, duration: null });
    expect(past.status).toBe(404);
    expect(past.body.error.message).toBe("This torrent has no such file");

    const unknown = await api
      .put(progressUrl(0, UNKNOWN))
      .send({ position: 3, duration: null });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe(
      "This torrent isn't in the library",
    );
  });

  it("answers 503 when the library is closed", async () => {
    await openMovie();
    services.library.close();

    for (const index of [0, 5]) {
      const res = await api
        .put(progressUrl(index))
        .send({ position: 3, duration: null });
      expect(res.status).toBe(503);
    }
  });

  it.each([
    [{ position: -1, duration: null }, "body.position"],
    [{ position: "1", duration: null }, "body.position"],
    [{ position: 1 }, "body.duration"],
    [{ position: 1, duration: null, audioTrack: 1.5 }, "body.audioTrack"],
    [{ position: 1, duration: null, subtitle: "" }, "body.subtitle"],
  ])("refuses %j (400)", async (body, path) => {
    await openMovie();
    const res = await api.put(progressUrl(0)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.ValidationFailed);
    expect(res.body.error.issues[0].path).toBe(path);
  });
});

describe("DELETE /v1/library/:infoHash/files/:fileIndex", () => {
  it("forgets the position: it leaves Continue watching", async () => {
    await openMovie();
    await api.put(progressUrl(0)).send({ position: 40, duration: 600 });

    expect((await api.delete(progressUrl(0))).status).toBe(204);

    expect((await api.get("/v1/library")).body.continueWatching).toEqual([]);
    expect(services.forgotten).toEqual([
      { infoHash: MOVIE.infoHash, fileIndex: 0 },
    ]);
    // Nothing saved: still fine.
    expect((await api.delete(progressUrl(0))).status).toBe(204);
  });
});

describe("DELETE /v1/library/:infoHash", () => {
  it("forgets the torrent: stopped, data deleted, gone from the library", async () => {
    await openMovie();
    const torrent = fakeClient.get(MOVIE.infoHash);

    expect((await api.delete(`/v1/library/${MOVIE.infoHash}`)).status).toBe(
      204,
    );

    expect(torrent.destroyed).toBe(true);
    expect(torrentService.isActive(MOVIE.infoHash)).toBe(false);
    expect((await api.get(`/v1/library/${MOVIE.infoHash}`)).status).toBe(404);
    expect((await api.delete(`/v1/library/${MOVIE.infoHash}`)).status).toBe(
      204,
    );
  });
});

describe("GET /v1/library/:infoHash/files/:fileIndex/thumbnail", () => {
  it("answers 404 until it exists, then the JPEG (revalidated every time)", async () => {
    await openMovie();
    const url = `${progressUrl(0)}/thumbnail`;
    expect((await api.get(url)).status).toBe(404);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const path = services.library.thumbnailPath(MOVIE.infoHash, 0);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, jpeg);

    const res = await api.get(url).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(Buffer.from(res.body as Buffer)).toEqual(jpeg);

    const again = await api
      .get(url)
      .set("If-None-Match", String(res.headers.etag));
    expect(again.status).toBe(304);
  });
});

describe("re-opening a torrent the library knows (POST /v1/torrents)", () => {
  it("starts from the saved metadata by its info hash, and counts as opened", async () => {
    await openMovie();
    await torrentService.stop(MOVIE.infoHash);
    const before = services.library.getTorrent(MOVIE.infoHash)?.lastOpenedAt;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    const res = await api.post("/v1/torrents").send({ magnet: MOVIE.infoHash });
    vi.useRealTimers();

    expect(res.status).toBe(201);
    const reopened = fakeClient.get(MOVIE.infoHash);
    expect(reopened.torrentId).toMatchObject({
      infoHash: MOVIE.infoHash,
      name: "Movie",
    });
    expect(reopened.torrentId).toHaveProperty("info");
    expect(
      services.library.getTorrent(MOVIE.infoHash)?.lastOpenedAt,
    ).toBeGreaterThan(before ?? Infinity);
  });

  it("gives a bare info hash the peers and trackers of the magnet it was added with", async () => {
    const files = [{ path: "Clip/clip.mp4", length: 2000 }];
    const { infoHash } = torrentFileFor("Clip", files);
    const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=Clip&tr=udp%3A%2F%2Ft.example%3A1&x.pe=203.0.113.5:6881`;
    await api.post("/v1/torrents").send({ magnet }).expect(201);
    await fakeClient
      .get(infoHash)
      .receiveMetadata("Clip", [
        { path: "Clip/clip.mp4", data: Buffer.alloc(2000) },
      ]);
    await torrentService.stop(infoHash);

    await api.post("/v1/torrents").send({ magnet: infoHash }).expect(201);

    // From the saved .torrent, with the saved magnet's peers and trackers.
    expect(fakeClient.get(infoHash).torrentId).toMatchObject({
      infoHash,
      announce: ["udp://tracker.example:1337", "udp://t.example:1"],
      peerAddresses: ["203.0.113.5:6881"],
    });
    expect(fakeClient.get(infoHash).torrentId).toHaveProperty("info");
    await torrentService.remove(infoHash, { forget: true });
  });
});
