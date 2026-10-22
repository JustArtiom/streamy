import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_SECRET_HEADER } from "../../shared/engine-protocol";
import { TEST_SECRET, useTestRuntime } from "../test/runtime";
import { createApp, isQuietRequest } from "./app";
import { isSecret } from "./security";

const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";

describe("isQuietRequest (hot paths aren't logged when they succeed)", () => {
  it.each([
    ["GET", "/v1/health"],
    ["GET", "/v1/torrents"],
    ["GET", `/v1/torrents/${HASH}`],
    ["GET", `/v1/torrents/${HASH}/files/0/stream`],
    ["HEAD", `/v1/torrents/${HASH}/files/12/stream`],
    ["GET", "/v1/playback/abc-123/index.m3u8"],
    ["GET", "/v1/playback/abc-123/init.mp4"],
    ["GET", "/v1/playback/abc-123/seg_00042.m4s"],
    ["POST", "/v1/playback/abc-123/heartbeat"],
    ["GET", `/v1/library/${HASH}/files/3/thumbnail`],
    ["GET", "/v1/torrents?x=1"],
    ["GET", "/internal/files/abc_DEF-123"],
  ])("%s %s is quiet", (method, url) => {
    expect(isQuietRequest(method, url)).toBe(true);
  });

  it.each([
    ["POST", "/v1/torrents"],
    ["DELETE", `/v1/torrents/${HASH}`],
    ["GET", `/v1/torrents/${HASH}/files/0/media`],
    ["POST", "/v1/playback"],
    ["DELETE", "/v1/playback/abc-123"],
    ["PUT", `/v1/library/${HASH}/files/3`],
    ["POST", "/v1/cache/clear"],
    ["GET", "/"],
  ])("%s %s is logged", (method, url) => {
    expect(isQuietRequest(method, url)).toBe(false);
  });
});

describe("security", () => {
  let cleanup: () => Promise<void>;
  const app = createApp({ secret: TEST_SECRET });

  beforeAll(async () => {
    ({ cleanup } = await useTestRuntime());
  });

  afterAll(async () => {
    await cleanup();
  });

  it("answers /v1 with the secret", async () => {
    const res = await request(app)
      .get("/v1/health")
      .set(ENGINE_SECRET_HEADER, TEST_SECRET);

    expect(res.status).toBe(200);
  });

  it.each([
    ["no key", undefined],
    ["a wrong key", "f".repeat(64)],
    ["a shorter key", TEST_SECRET.slice(0, 10)],
    ["a longer key", `${TEST_SECRET}0`],
  ])("refuses /v1 with %s (401)", async (_name, key) => {
    const req = request(app).get("/v1/health");
    if (key !== undefined) req.set(ENGINE_SECRET_HEADER, key);
    const res = await req;

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Missing or wrong key",
    });
  });

  it("checks the secret before the route exists (no probing for routes)", async () => {
    const res = await request(app).get("/v1/nothing-here");
    expect(res.status).toBe(401);
  });

  it.each([
    "evil.example",
    "evil.example:1234",
    "localhost",
    "127.0.0.1",
    "127.0.0.1:1",
  ])("refuses Host %s (DNS rebinding), even with the key", async (host) => {
    const res = await request(app)
      .get("/v1/health")
      .set("Host", host)
      .set(ENGINE_SECRET_HEADER, TEST_SECRET);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a bad Host for the internal file route too", async () => {
    const res = await request(app)
      .get("/internal/files/whatever")
      .set("Host", "evil.example");
    expect(res.status).toBe(403);
  });

  it("needs no key for /internal/files (the token is the key)", async () => {
    const res = await request(app).get("/internal/files/not-a-real-token");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "Not found",
    });
  });

  it("answers unknown paths with a 404 ApiError", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("isSecret compares exactly", () => {
    expect(isSecret(TEST_SECRET, TEST_SECRET)).toBe(true);
    expect(isSecret(undefined, TEST_SECRET)).toBe(false);
    expect(isSecret("", TEST_SECRET)).toBe(false);
    expect(isSecret(TEST_SECRET.toUpperCase(), TEST_SECRET)).toBe(false);
  });
});

describe("GET /v1/health", () => {
  let cleanup: () => Promise<void>;
  const app = createApp({ secret: TEST_SECRET });

  beforeAll(async () => {
    ({ cleanup } = await useTestRuntime());
  });

  afterAll(async () => {
    await cleanup();
  });

  it("reports the version, uptime, and nulls while checks run", async () => {
    const res = await request(app)
      .get("/v1/health")
      .set(ENGINE_SECRET_HEADER, TEST_SECRET);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: "0.0.0-test",
      uptime: expect.any(Number) as number,
      ffmpeg: { version: null, error: null },
      encoder: null,
      lowDiskSpace: false,
    });
  });
});
