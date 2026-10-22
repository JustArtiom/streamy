import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toTorrentFile } from "parse-torrent";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ENGINE_SECRET_HEADER } from "../../../../shared/engine-protocol";
import { createApp } from "../../../http/app";
import { ErrorCode } from "../../../http/errors";
import { fakeClient, makeTorrentFile } from "../../../test/fake-torrent-client";
import { TEST_SECRET, useTestRuntime } from "../../../test/runtime";
import {
  revokeAllFileTokens,
  setInternalOrigin,
} from "../../../torrents/file-tokens";
import { type TorrentRemoval, torrentService } from "../../../torrents/service";

vi.mock("../../../torrents/client", async () => {
  const { fakeClient } = await import("../../../test/fake-torrent-client");
  return {
    getTorrentClient: () => fakeClient,
    destroyTorrentClient: () => Promise.resolve(),
  };
});

const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
const OTHER = "c9e15763f722f23e98a29decdfae341b98d53056";
const VIDEO = Buffer.from("0123456789".repeat(10)); // 100 bytes
const app = createApp({ secret: TEST_SECRET });

/** Requests to /v1 with the secret, like main's proxy sends them. */
const api = {
  get: (url: string) =>
    request(app).get(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
  head: (url: string) =>
    request(app).head(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
  post: (url: string) =>
    request(app).post(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
  delete: (url: string) =>
    request(app).delete(url).set(ENGINE_SECRET_HEADER, TEST_SECRET),
};

/** Adds a torrent with a 100-byte video, a subtitle and an empty file. */
async function addReady() {
  await api.post("/v1/torrents").send({ magnet: HASH }).expect(201);
  const torrent = fakeClient.get(HASH);
  await torrent.receiveMetadata("Sintel", [
    { path: "Sintel/Sintel.mp4", data: VIDEO },
    {
      path: "Sintel/Sintel.en.srt",
      data: Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHi\n"),
    },
    { path: "Sintel/empty.mkv" },
  ]);
  return torrent;
}

const streamUrl = (index: number, hash = HASH) =>
  `/v1/torrents/${hash}/files/${index}/stream`;

/** GET with the body as raw bytes (supertest doesn't keep video bodies). */
function getBytes(url: string, range?: string, withKey = true) {
  const req = withKey ? api.get(url) : request(app).get(url);
  if (range) req.set("Range", range);
  return req.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => {
      callback(null, Buffer.concat(chunks));
    });
  });
}

let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ cleanup } = await useTestRuntime());
});

afterAll(async () => {
  setInternalOrigin(null);
  await cleanup();
});

afterEach(async () => {
  for (const { infoHash } of torrentService.list()) {
    await torrentService.remove(infoHash);
  }
  fakeClient.torrents = [];
  revokeAllFileTokens();
});

describe("POST /v1/torrents", () => {
  it("answers 201 for a new torrent, 200 when it was already added", async () => {
    const first = await api
      .post("/v1/torrents")
      .send({ magnet: `magnet:?xt=urn:btih:${HASH}&dn=Sintel` });
    const second = await api.post("/v1/torrents").send({ magnet: HASH });

    expect(first.status).toBe(201);
    expect(first.body.torrent).toMatchObject({
      infoHash: HASH,
      status: "fetching_metadata",
      files: [],
    });
    expect(second.status).toBe(200);
    expect(second.body.torrent.infoHash).toBe(HASH);
  });

  it.each([
    [
      "not a magnet",
      "Paste a magnet link (magnet:?xt=urn:btih:…) or a 40-character info hash",
    ],
    [
      `magnet:?xt=urn:btmh:1220${"a".repeat(64)}`,
      "BitTorrent v2-only magnets aren't supported yet",
    ],
  ])("rejects %j with a field error", async (magnet, message) => {
    const res = await api.post("/v1/torrents").send({ magnet });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.ValidationFailed);
    expect(res.body.error.issues).toEqual([{ path: "body.magnet", message }]);
  });

  it("rejects a missing magnet, in words people understand", async () => {
    const res = await api.post("/v1/torrents").send({});

    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([
      { path: "body.magnet", message: "Paste a magnet link or an info hash" },
    ]);
  });

  it("takes magnets up to 16,384 characters, like main", async () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=`;
    const longest = magnet + "x".repeat(16_384 - magnet.length);

    expect(
      (await api.post("/v1/torrents").send({ magnet: longest })).status,
    ).toBe(201);
    const tooLong = await api
      .post("/v1/torrents")
      .send({ magnet: `${longest}x` });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.issues).toEqual([
      {
        path: "body.magnet",
        message:
          "This magnet link is too long (the limit is 16,384 characters)",
      },
    ]);
  });
});

describe("POST /v1/torrents/file", () => {
  it("adds the raw .torrent bytes", async () => {
    const { bytes, infoHash } = makeTorrentFile({
      name: "Movie",
      files: [{ path: ["movie.mkv"], length: 1000 }],
    });

    const res = await api
      .post("/v1/torrents/file")
      .set("Content-Type", "application/x-bittorrent")
      .send(bytes);

    expect(res.status).toBe(201);
    expect(res.body.torrent.infoHash).toBe(infoHash);
  });

  it("rejects bytes that aren't a .torrent", async () => {
    const res = await api
      .post("/v1/torrents/file")
      .set("Content-Type", "application/x-bittorrent")
      .send(Buffer.from("hello"));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("This isn't a valid .torrent file");
  });

  it("rejects a crafted .torrent with ../ paths", async () => {
    const bytes = toTorrentFile({
      info: {
        name: Buffer.from("Evil"),
        "piece length": 16384,
        pieces: Buffer.alloc(20),
        files: [
          {
            length: 10,
            path: ["..", "..", "evil.sh"].map((part) => Buffer.from(part)),
          },
        ],
      },
    });

    const res = await api
      .post("/v1/torrents/file")
      .set("Content-Type", "application/x-bittorrent")
      .send(Buffer.from(bytes));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      "This torrent has file names Streamy can't save safely.",
    );
    expect(fakeClient.torrents).toHaveLength(0);
  });

  it("answers 413 for a .torrent over 10 MB", async () => {
    const res = await api
      .post("/v1/torrents/file")
      .set("Content-Type", "application/x-bittorrent")
      .send(Buffer.alloc(10 * 1024 * 1024 + 1));

    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({
      code: ErrorCode.PayloadTooLarge,
      message: "This .torrent file is too big (the limit is 10 MB)",
    });
  });

  it("asks for the right content type", async () => {
    const res = await api
      .post("/v1/torrents/file")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("hello"));

    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].message).toMatch(
      /application\/x-bittorrent/,
    );
  });
});

describe("GET /v1/torrents and /v1/torrents/:infoHash", () => {
  it("lists torrents and shows one with its files", async () => {
    await addReady();

    const list = await api.get("/v1/torrents");
    const one = await api.get(`/v1/torrents/${HASH.toUpperCase()}`);

    expect(list.status).toBe(200);
    expect(list.body.torrents).toHaveLength(1);
    expect(list.body.torrents[0]).not.toHaveProperty("files");
    expect(one.status).toBe(200);
    expect(one.body.torrent).toMatchObject({
      infoHash: HASH,
      status: "ready",
      name: "Sintel",
    });
    expect(
      one.body.torrent.files.map((file: { kind: string }) => file.kind),
    ).toEqual(["video", "subtitle", "video"]);
  });

  it("answers 404 for an unknown torrent, 400 for a bad hash", async () => {
    expect((await api.get(`/v1/torrents/${OTHER}`)).status).toBe(404);
    expect((await api.get("/v1/torrents/nope")).status).toBe(400);
  });
});

describe("DELETE /v1/torrents/:infoHash", () => {
  it("answers 204, then the torrent is gone", async () => {
    const torrent = await addReady();

    const res = await api.delete(`/v1/torrents/${HASH}`);

    expect(res.status).toBe(204);
    expect(torrent.destroyed).toBe(true);
    expect((await api.get(`/v1/torrents/${HASH}`)).status).toBe(404);
    // Nothing left to delete: still 204 (the outcome is the same).
    expect((await api.delete(`/v1/torrents/${HASH}`)).status).toBe(204);
    expect((await api.delete(`/v1/torrents/${OTHER}`)).status).toBe(204);
  });

  it("passes ?forget=true on to the library's listener", async () => {
    await addReady();
    const removals: TorrentRemoval[] = [];
    const unsubscribe = torrentService.onRemoved((_hash, removal) =>
      removals.push(removal),
    );

    expect((await api.delete(`/v1/torrents/${HASH}?forget=true`)).status).toBe(
      204,
    );
    // Not active anymore and nothing on disk: forgetting still works.
    expect((await api.delete(`/v1/torrents/${HASH}?forget=true`)).status).toBe(
      204,
    );
    expect(removals).toEqual([
      { dataDeleted: true, forget: true },
      { dataDeleted: false, forget: true },
    ]);
    expect((await api.delete(`/v1/torrents/${HASH}?forget=yes`)).status).toBe(
      400,
    );
    unsubscribe();
  });
});

describe("GET /v1/torrents/:infoHash/files/:fileIndex/stream", () => {
  it("sends the whole file without a Range", async () => {
    await addReady();

    const res = await getBytes(streamUrl(0));

    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-type": "video/mp4",
      "content-length": "100",
      "cache-control": "no-store",
    });
    expect(res.headers["content-range"]).toBeUndefined();
    expect(Buffer.from(res.body as Buffer)).toEqual(VIDEO);
  });

  it.each([
    ["bytes=10-19", "bytes 10-19/100", "0123456789"],
    ["bytes=95-", "bytes 95-99/100", "56789"],
    ["bytes=-3", "bytes 97-99/100", "789"],
    ["bytes=98-5000", "bytes 98-99/100", "89"],
    ["bytes=0-0", "bytes 0-0/100", "0"],
  ])("answers %s with 206 %s", async (range, contentRange, body) => {
    await addReady();

    const res = await getBytes(streamUrl(0), range);

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(contentRange);
    expect(res.headers["content-length"]).toBe(String(body.length));
    expect(Buffer.from(res.body as Buffer).toString()).toBe(body);
  });

  it("answers 416 for a range past the end", async () => {
    await addReady();

    const res = await api.get(streamUrl(0)).set("Range", "bytes=100-");

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */100");
  });

  it("sends everything for several ranges", async () => {
    await addReady();

    const res = await getBytes(streamUrl(0), "bytes=0-1,5-6");

    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("100");
  });

  it("answers HEAD with the headers and starts no read", async () => {
    const torrent = await addReady();

    const res = await api.head(streamUrl(0)).set("Range", "bytes=10-");

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 10-99/100");
    expect(res.headers["content-length"]).toBe("90");
    expect(torrent.files[0]?.readsStarted).toBe(0);
  });

  it("sends an empty file as 200 with no body", async () => {
    await addReady();

    const res = await api.get(streamUrl(2)).set("Range", "bytes=0-");

    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("0");
    expect(res.headers["content-type"]).toBe("video/x-matroska");
  });

  it("uses the subtitle's content type", async () => {
    await addReady();

    const res = await getBytes(streamUrl(1));

    expect(res.headers["content-type"]).toBe("application/x-subrip");
  });

  it("answers 404 / 409 / 400 for unknown torrents, missing metadata and bad params", async () => {
    expect((await api.get(streamUrl(0, OTHER))).status).toBe(404);

    await api.post("/v1/torrents").send({ magnet: OTHER });
    const waiting = await api.get(streamUrl(0, OTHER));
    expect(waiting.status).toBe(409);
    expect(waiting.body.error.code).toBe(ErrorCode.Conflict);

    await addReady();
    expect((await api.get(streamUrl(9))).status).toBe(404);
    expect((await api.get(`/v1/torrents/${HASH}/files/-1/stream`)).status).toBe(
      400,
    );
    expect((await api.get("/v1/torrents/xyz/files/0/stream")).status).toBe(400);
  });

  it("marks the torrent as in use", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    await addReady();
    vi.setSystemTime(new Date("2026-01-01T12:10:00Z"));

    await api.head(streamUrl(0));

    expect(torrentService.list()[0]?.lastActivityAt).toBe(
      "2026-01-01T12:10:00.000Z",
    );
    vi.useRealTimers();
  });

  it("needs the key", async () => {
    await addReady();
    expect((await request(app).get(streamUrl(0))).status).toBe(401);
  });

  it("releases the pieces when the viewer goes away mid-stream", async () => {
    const torrent = await addReady();
    const [video] = torrent.files;
    if (!video) throw new Error("no video");
    video.stalled = true; // the pieces never arrive

    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const req = httpRequest({
      port,
      host: "127.0.0.1",
      path: streamUrl(0),
      headers: { Range: "bytes=50-", [ENGINE_SECRET_HEADER]: TEST_SECRET },
    });
    req.on("error", () => undefined); // we're the ones hanging up
    req.end();
    await vi.waitFor(() => {
      expect(video.openReads).toBe(1);
    });

    req.destroy();
    await vi.waitFor(() => {
      expect(video.openReads).toBe(0);
    });
    server.close();
  });
});

describe("GET /internal/files/:token (ffmpeg's way in)", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    // A real server: token URLs carry its address.
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setInternalOrigin(origin);
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("reads the one file the token was made for, with Range, without the key", async () => {
    await addReady();
    const internal = torrentService.getFile(HASH, 0).mintInternalUrl();

    const res = await fetch(internal.url, {
      headers: { Range: "bytes=10-19" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(await res.text()).toBe("0123456789");
    // The same token can't be pointed at another file.
    const path = new URL(internal.url).pathname;
    const other = await fetch(`${origin}${path}/../1`);
    expect(other.status).toBe(404);
    internal.revoke();
  });

  it("stops working once revoked, or when its torrent goes away", async () => {
    await addReady();
    const revoked = torrentService.getFile(HASH, 0).mintInternalUrl();
    const removed = torrentService.getFile(HASH, 1).mintInternalUrl();
    revoked.revoke();

    expect((await fetch(revoked.url)).status).toBe(404);
    expect((await fetch(removed.url)).status).toBe(200);
    await torrentService.remove(HASH);
    expect((await fetch(removed.url)).status).toBe(404);
  });

  it("answers HEAD without reading", async () => {
    const torrent = await addReady();
    const internal = torrentService.getFile(HASH, 0).mintInternalUrl();

    const res = await fetch(internal.url, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("100");
    expect(torrent.files[0]?.readsStarted).toBe(0);
    internal.revoke();
  });
});
