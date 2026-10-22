import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_SECRET_HEADER } from "../../shared/engine-protocol";
import type { EngineConnection } from "./host";
import { type ApiProxy, createApiProxy } from "./proxy";

// A real HTTP server plays the engine, so the proxy is tested over real
// sockets: streaming, Range, cancellation.

const SECRET = "a".repeat(64);

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let port: number;
let handler: Handler;
/** Every request the "engine" received. */
let received: IncomingMessage[];
let proxy: ApiProxy;

beforeEach(async () => {
  received = [];
  handler = (_request, response) => {
    response.end("ok");
  };
  server = createServer((request, response) => {
    received.push(request);
    handler(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
  proxy = createApiProxy({ engine: () => ({ port, secret: SECRET }) });
});

afterEach(async () => {
  proxy.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const call = (path: string, init?: RequestInit, through = proxy) =>
  through.handle(new Request(`app://streamy/api${path}`, init), path);

describe("forwarding", () => {
  it("sends the path and query to the engine, with the secret", async () => {
    handler = (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ url: request.url }));
    };

    const response = await call("/v1/torrents?sort=new%20first");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "/v1/torrents?sort=new%20first",
    });
    expect(received[0]?.headers[ENGINE_SECRET_HEADER]).toBe(SECRET);
    expect(received[0]?.headers.host).toBe(`127.0.0.1:${port}`);
  });

  it("never passes on a secret sent by the page", async () => {
    await call("/v1/health", {
      headers: { [ENGINE_SECRET_HEADER]: "guessed" },
    });

    expect(received[0]?.headers[ENGINE_SECRET_HEADER]).toBe(SECRET);
  });

  it("passes on only the request headers the API needs", async () => {
    await call("/v1/health", {
      headers: {
        accept: "application/json",
        "if-none-match": '"v1"',
        cookie: "a=b",
        "x-anything": "else",
        authorization: "Bearer x",
      },
    });

    const headers = received[0]?.headers ?? {};
    expect(headers.accept).toBe("application/json");
    expect(headers["if-none-match"]).toBe('"v1"');
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-anything"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("passes back only the response headers the page needs", async () => {
    handler = (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        etag: '"v2"',
        "x-request-id": "req-1",
        "set-cookie": "a=b",
        "x-powered-by": "Express",
        "access-control-allow-origin": "*",
      });
      response.end("hi");
    };

    const response = await call("/v1/health");

    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("etag")).toBe('"v2"');
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toBe("hi");
  });

  it("passes on Range requests and partial answers", async () => {
    handler = (_request, response) => {
      response.writeHead(206, {
        "content-type": "video/mp4",
        "content-range": "bytes 10-19/100",
        "content-length": "10",
        "accept-ranges": "bytes",
      });
      response.end("0123456789");
    };

    const response = await call("/v1/torrents/x/files/0/stream", {
      headers: { range: "bytes=10-19", "if-range": '"v1"' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(received[0]?.headers.range).toBe("bytes=10-19");
    expect(received[0]?.headers["if-range"]).toBe('"v1"');
    expect(await response.text()).toBe("0123456789");
  });

  it("uploads a request body (a .torrent file)", async () => {
    const torrent = Buffer.alloc(3 * 1024 * 1024, 7);
    let uploaded = 0;
    handler = (request, response) => {
      request.on("data", (chunk: Buffer) => {
        uploaded += chunk.length;
      });
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ type: request.headers["content-type"], uploaded }),
        );
      });
    };

    const response = await call("/v1/torrents/file", {
      method: "POST",
      headers: { "content-type": "application/x-bittorrent" },
      body: torrent,
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      type: "application/x-bittorrent",
      uploaded: torrent.length,
    });
  });

  it("streams big answers without waiting for the end", async () => {
    let finish: () => void = () => undefined;
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(64 * 1024, 1));
      // The rest only comes once the test says so.
      finish = () => response.end(Buffer.alloc(64 * 1024, 2));
    };

    const response = await call("/v1/big");
    const reader = (
      response.body as ReadableStream<Uint8Array> | null
    )?.getReader();
    if (!reader) throw new Error("No body");
    const first = await reader.read();
    expect(first.value?.[0]).toBe(1);

    finish();
    let total = first.value?.length ?? 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
    }
    expect(total).toBe(128 * 1024);
  });

  it("closes the engine's response when the page stops reading", async () => {
    const closed = new Promise<boolean>((resolve) => {
      handler = (_request, response) => {
        response.writeHead(200, { "content-type": "video/mp4" });
        const chunk = Buffer.alloc(64 * 1024);
        const timer = setInterval(() => response.write(chunk), 5);
        response.on("close", () => {
          clearInterval(timer);
          resolve(response.writableFinished);
        });
      };
    });

    const response = await call("/v1/torrents/x/files/0/stream");
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    expect(await closed).toBe(false); // closed early, not finished
  });

  // Electron 45 never fires request.signal for protocol.handle requests, so
  // in the app this only happens once Electron does; this checks our side.
  it("closes the engine's request when the request's signal aborts", async () => {
    const closed = new Promise<void>((resolve) => {
      handler = (request) => {
        // Like a blocking HLS playlist reload: no answer yet.
        request.on("close", resolve);
      };
    });
    const controller = new AbortController();

    const pending = call("/v1/playback/1/index.m3u8?_HLS_msn=5", {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await closed;
    // The proxy answers something; the page has stopped listening anyway.
    expect((await pending).status).toBe(502);
  });

  it("returns no body for 204 and HEAD", async () => {
    handler = (request, response) => {
      response.writeHead(request.method === "HEAD" ? 200 : 204, {
        "content-length": request.method === "HEAD" ? "5" : "0",
      });
      response.end();
    };

    const deleted = await call("/v1/torrents/x", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeNull();

    const head = await call("/v1/torrents/x/files/0/stream", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("5");
  });
});

describe("headers on every answer", () => {
  it("tells the page never to guess a content type (nosniff)", async () => {
    handler = (request, response) => {
      response.writeHead(request.method === "DELETE" ? 204 : 200, {
        "content-type": "text/plain",
      });
      response.end(request.method === "DELETE" ? undefined : "hi");
    };
    const stopped = createApiProxy({ engine: () => null });

    const answers = [
      await call("/v1/health"),
      await call("/v1/torrents/x", { method: "DELETE" }),
      await call("/v1/health", undefined, stopped),
    ];

    for (const answer of answers) {
      expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    }
    stopped.close();
  });
});

describe("commands (anything but GET/HEAD)", () => {
  it("passes DELETE on (the player stops its sessions with it)", async () => {
    handler = (_request, response) => {
      response.writeHead(204);
      response.end();
    };

    const response = await call("/v1/players/abc", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(received[0]?.method).toBe("DELETE");
    expect(received[0]?.url).toBe("/v1/players/abc");
  });

  it("answers 504 when the engine takes too long, and closes its request", async () => {
    const closed = new Promise<void>((resolve) => {
      handler = (request) => {
        request.on("close", resolve); // never answers
      };
    });
    const slow = createApiProxy({
      engine: () => ({ port, secret: SECRET }),
      commandTimeoutMs: 50,
    });

    const response = await call(
      "/v1/playback",
      { method: "POST", body: "{}" },
      slow,
    );

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    await closed;
    expect(slow.pendingCommands()).toBe(0);
    slow.close();
  });

  it("lets reads wait as long as the engine needs (video waits for peers)", async () => {
    handler = (_request, response) => {
      setTimeout(() => response.end("late"), 150);
    };
    const slow = createApiProxy({
      engine: () => ({ port, secret: SECRET }),
      commandTimeoutMs: 50,
    });

    const response = await call("/v1/torrents/x/files/0/stream", {}, slow);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("late");
    slow.close();
  });

  it("counts commands until the engine answers them", async () => {
    let answer: () => void = () => undefined;
    handler = (request, response) => {
      if (request.method === "GET") {
        // A read that stays open doesn't count.
        response.writeHead(200);
        response.flushHeaders();
        return;
      }
      answer = () => response.end("{}");
    };

    const read = await call("/v1/torrents/x/files/0/stream");
    expect(read.status).toBe(200);
    const put = call("/v1/library/x/files/0/progress", {
      method: "PUT",
      body: "{}",
    });
    expect(proxy.pendingCommands()).toBe(1);
    await vi.waitFor(() => {
      expect(received).toHaveLength(2); // the engine has it
    });
    expect(proxy.pendingCommands()).toBe(1);

    answer();
    await put;
    expect(proxy.pendingCommands()).toBe(0);
    await read.body?.cancel();
  });
});

describe("whenIdle (quitting waits for the last saves)", () => {
  it("waits until the engine has answered the commands on their way", async () => {
    const order: string[] = [];
    handler = (_request, response) => {
      setTimeout(() => {
        order.push("engine answered");
        response.end("{}");
      }, 100);
    };

    const save = call("/v1/library/x/files/0/progress", {
      method: "PUT",
      body: "{}",
    });
    await vi.waitFor(() => {
      expect(proxy.pendingCommands()).toBe(1);
    });
    await proxy.whenIdle({ quietMs: 10, maxMs: 5_000 });
    order.push("idle");

    expect(order).toEqual(["engine answered", "idle"]);
    await save;
  });

  it("waits a moment for a command that's still on its way", async () => {
    const idle = proxy.whenIdle({ quietMs: 100, maxMs: 5_000 });
    // The closing page's save arrives a little after the window closed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const save = call("/v1/library/x/files/0/progress", {
      method: "PUT",
      body: "{}",
    });

    await idle;
    expect(received.map((request) => request.method)).toEqual(["PUT"]);
    expect((await save).status).toBe(200);
  });

  it("never waits longer than maxMs", async () => {
    handler = () => undefined; // never answers
    void call("/v1/library/x/files/0/progress", { method: "PUT", body: "{}" });
    await vi.waitFor(() => {
      expect(proxy.pendingCommands()).toBe(1);
    });

    const started = Date.now();
    await proxy.whenIdle({ quietMs: 10, maxMs: 100 });

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("when the engine can't answer", () => {
  it("answers 503 with an ApiError while the engine isn't running", async () => {
    const stopped = createApiProxy({ engine: () => null });

    const response = await call("/v1/health", undefined, stopped);

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The playback engine isn't running. Try again in a moment.",
      },
    });
    stopped.close();
  });

  it("answers 502 with an ApiError when the connection fails", async () => {
    const closedPort = await unusedPort();
    const broken = createApiProxy({
      engine: (): EngineConnection => ({ port: closedPort, secret: SECRET }),
    });

    const response = await call("/v1/health", undefined, broken);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    broken.close();
  });
});

describe("dev mode (page from the Vite server)", () => {
  const DEV_ORIGIN = "http://localhost:5173";

  it("adds CORS headers for the dev server only", async () => {
    const dev = createApiProxy({
      engine: () => ({ port, secret: SECRET }),
      devOrigin: DEV_ORIGIN,
    });

    const response = await call("/v1/health", undefined, dev);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      DEV_ORIGIN,
    );
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "content-range",
    );

    const production = await call("/v1/health");
    expect(production.headers.get("access-control-allow-origin")).toBeNull();
    dev.close();
  });

  it("answers preflight requests itself", async () => {
    const dev = createApiProxy({
      engine: () => ({ port, secret: SECRET }),
      devOrigin: DEV_ORIGIN,
    });

    const response = await call("/v1/torrents", { method: "OPTIONS" }, dev);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      DEV_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "content-type",
    );
    expect(received).toHaveLength(0);
    dev.close();
  });

  it("adds CORS headers to its own error answers too", async () => {
    const dev = createApiProxy({ engine: () => null, devOrigin: DEV_ORIGIN });

    const response = await call("/v1/health", undefined, dev);

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      DEV_ORIGIN,
    );
    dev.close();
  });
});

/** A port nothing listens on (it was free a moment ago). */
async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port: free } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return free;
}
