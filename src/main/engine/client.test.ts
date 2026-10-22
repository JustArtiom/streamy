import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CacheInfo } from "../../shared/engine-api";
import { ENGINE_SECRET_HEADER } from "../../shared/engine-protocol";
import { silentLogger } from "../logs";
import {
  addTorrentFile,
  callEngine,
  createCacheEngine,
  EngineRequestError,
} from "./client";
import type { EngineConnection } from "./host";

const SECRET = "b".repeat(64);
const INFO_HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";

type Handler = (
  request: IncomingMessage,
  body: Buffer,
  response: ServerResponse,
) => void;

let server: Server;
let connection: EngineConnection;
let handler: Handler;

beforeEach(async () => {
  handler = (_request, _body, response) => {
    response.end();
  };
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      handler(request, Buffer.concat(chunks), response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  connection = { port: (server.address() as AddressInfo).port, secret: SECRET };
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("callEngine", () => {
  it("sends the secret and returns the JSON answer", async () => {
    handler = (request, _body, response) => {
      json(response, 200, { key: request.headers[ENGINE_SECRET_HEADER] });
    };

    expect(await callEngine(connection, "/v1/health")).toEqual({
      key: SECRET,
    });
  });

  it("turns an ApiError into a message for people", async () => {
    handler = (_request, _body, response) => {
      json(response, 400, {
        error: { code: "BAD_REQUEST", message: "That isn't a torrent file." },
      });
    };

    const error = await callEngine(connection, "/v1/x").catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(EngineRequestError);
    expect(error).toMatchObject({
      message: "That isn't a torrent file.",
      status: 400,
    });
  });

  it("still explains errors without a JSON body", async () => {
    handler = (_request, _body, response) => {
      response.writeHead(500).end("oops");
    };

    await expect(callEngine(connection, "/v1/x")).rejects.toMatchObject({
      message: expect.stringContaining("500") as unknown,
      status: 500,
    });
  });

  it("says when the engine can't be reached", async () => {
    const gone = { ...connection };
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server.listen(0); // so afterEach has something to close

    await expect(callEngine(gone, "/v1/health")).rejects.toMatchObject({
      status: null,
      message: expect.stringContaining("couldn't reach") as unknown,
    });
  });
});

describe("addTorrentFile", () => {
  it("uploads the file and returns its info hash", async () => {
    let received: { type?: string; size: number } | undefined;
    handler = (request, body, response) => {
      received = { type: request.headers["content-type"], size: body.length };
      json(response, 201, { torrent: { infoHash: INFO_HASH, name: "x" } });
    };

    expect(await addTorrentFile(connection, new Uint8Array(1234))).toBe(
      INFO_HASH,
    );
    expect(received).toEqual({
      type: "application/x-bittorrent",
      size: 1234,
    });
  });

  it("refuses an answer it doesn't understand", async () => {
    handler = (_request, _body, response) => {
      json(response, 200, { torrent: { infoHash: "not-a-hash" } });
    };

    await expect(
      addTorrentFile(connection, new Uint8Array(1)),
    ).rejects.toBeInstanceOf(EngineRequestError);
  });
});

describe("createCacheEngine", () => {
  const info: CacheInfo = {
    dir: "/videos",
    exists: true,
    usedBytes: 1234,
    limitBytes: null,
    freeBytes: 99,
    lowDiskSpace: false,
  };
  const running = () =>
    createCacheEngine({ connection: () => connection }, silentLogger());
  const stopped = createCacheEngine({ connection: () => null }, silentLogger());

  it("asks the engine how much space the videos take", async () => {
    handler = (_request, _body, response) => {
      json(response, 200, info);
    };

    expect(await running().usage("/videos")).toEqual({
      status: "ok",
      bytes: 1234,
    });
  });

  it("reports a folder the engine can't find", async () => {
    handler = (_request, _body, response) => {
      json(response, 200, { ...info, exists: false });
    };

    expect(await running().usage("/videos")).toEqual({ status: "missing" });
  });

  it("can't tell (null) when the engine is stopped, older, or elsewhere", async () => {
    expect(await stopped.usage("/videos")).toBeNull();

    handler = (_request, _body, response) => {
      json(response, 404, { error: { code: "NOT_FOUND", message: "No." } });
    };
    expect(await running().usage("/videos")).toBeNull();

    handler = (_request, _body, response) => {
      json(response, 200, info);
    };
    expect(await running().usage("/other-folder")).toBeNull();
  });

  it("asks the engine to clear the videos", async () => {
    let cleared = false;
    handler = (request, _body, response) => {
      cleared = request.method === "POST" && request.url === "/v1/cache/clear";
      response.writeHead(204).end();
    };

    expect(await running().clear()).toEqual({ status: "ok" });
    expect(cleared).toBe(true);
  });

  it("explains why it couldn't clear the videos", async () => {
    expect(await stopped.clear()).toEqual({
      status: "error",
      message: "The playback engine isn't running. Try again in a moment.",
    });

    handler = (_request, _body, response) => {
      json(response, 409, {
        error: { code: "CONFLICT", message: "A video is playing." },
      });
    };
    expect(await running().clear()).toEqual({
      status: "error",
      message: "A video is playing.",
    });

    handler = (_request, _body, response) => {
      json(response, 404, { error: { code: "NOT_FOUND", message: "No." } });
    };
    expect(await running().clear()).toMatchObject({ status: "error" });
  });
});
