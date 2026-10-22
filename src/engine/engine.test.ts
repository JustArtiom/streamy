import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { Agent, type IncomingMessage, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Health } from "../shared/engine-api";
import {
  ENGINE_SECRET_HEADER,
  type EngineToMainMessage,
} from "../shared/engine-protocol";
import { getRuntime } from "./config";
import {
  type ParentPortLike,
  type RunningEngine,
  runEngineProcess,
  startEngine,
} from "./engine";
import { logger } from "./lib/logger";
import { LATEST_VERSION } from "./library/migrations";
import { engineServices } from "./services";
import {
  findFfmpeg,
  makeVideoFolder,
  TEST_SECRET,
  testInitMessage,
} from "./test/runtime";
import { resetTorrentClientForTests } from "./torrents/client";

/*
 * The engine as main runs it, minus Electron: a fake parentPort, the real
 * HTTP server, log file, ffmpeg check and folders.
 */

/** Stands in for Electron's process.parentPort. */
class FakePort implements ParentPortLike {
  posted: EngineToMainMessage[] = [];
  private listener: ((event: { data: unknown }) => void) | null = null;

  on(_event: "message", listener: (event: { data: unknown }) => void) {
    this.listener = listener;
  }

  postMessage(message: unknown) {
    this.posted.push(message as EngineToMainMessage);
  }

  /** main → engine */
  send(data: unknown) {
    this.listener?.({ data });
  }

  async waitFor<T extends EngineToMainMessage["type"]>(type: T) {
    await vi.waitFor(
      () => {
        expect(this.posted.map((m) => m.type)).toContain(type);
      },
      { timeout: 10_000 },
    );
    return this.posted.find((m) => m.type === type) as Extract<
      EngineToMainMessage,
      { type: T }
    >;
  }
}

/** A request with any Host header (fetch won't let us change it). */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "streamy-engine-"));
});

afterEach(async () => {
  resetTorrentClientForTests();
  await rm(base, { recursive: true, force: true });
});

describe("runEngineProcess", () => {
  it("init → ready, config, shutdown → exit 0", async () => {
    const port = new FakePort();
    const exit = vi.fn();
    let engine: RunningEngine | null = null;
    runEngineProcess(port, {
      exit,
      stderr: () => undefined,
      start: async (...args) => {
        engine = await startEngine(...args);
        return engine;
      },
    });

    // Leftovers from a previous run, and the cache that must survive.
    const cache = join(base, "cache");
    await makeVideoFolder(cache);
    await mkdir(join(cache, "playback", "old-session"), { recursive: true });
    await mkdir(join(cache, "subtitles", "old"), { recursive: true });
    await mkdir(join(cache, "torrents", "a".repeat(40)), { recursive: true });
    await writeFile(join(cache, "torrents", "a".repeat(40), "movie.mkv"), "x");

    port.send(testInitMessage(base));
    const ready = await port.waitFor("ready");
    expect(ready.port).toBeGreaterThan(0);

    expect(existsSync(join(cache, "playback", "old-session"))).toBe(false);
    expect(existsSync(join(cache, "subtitles", "old"))).toBe(false);
    expect(
      existsSync(join(cache, "torrents", "a".repeat(40), "movie.mkv")),
    ).toBe(true);

    // Health, with the secret, on 127.0.0.1 only.
    const url = `http://127.0.0.1:${ready.port}/v1/health`;
    const health = await vi.waitFor(
      async () => {
        const res = await fetch(url, {
          headers: { [ENGINE_SECRET_HEADER]: TEST_SECRET },
        });
        const body = (await res.json()) as Health;
        expect(body.ffmpeg.version ?? body.ffmpeg.error).not.toBeNull();
        return body;
      },
      { timeout: 10_000 },
    );
    expect(health.version).toBe("0.0.0-test");
    if (findFfmpeg()) expect(health.ffmpeg.error).toBeNull();
    expect((await fetch(url)).status).toBe(401);
    expect(
      (
        await rawGet(ready.port, "/v1/health", {
          Host: "evil.example",
          [ENGINE_SECRET_HEADER]: TEST_SECRET,
        })
      ).status,
    ).toBe(403);

    // config: applied as a whole.
    const config = {
      ...testInitMessage(base).config,
      hardwareEncoding: "off" as const,
      downloadLimit: 1_000_000,
    };
    port.send({ type: "config", config });
    expect(getRuntime().config).toEqual(config);
    const after = (await (
      await fetch(url, { headers: { [ENGINE_SECRET_HEADER]: TEST_SECRET } })
    ).json()) as Health;
    expect(after.encoder).toBe("libx264");

    // shutdown: stops, exits 0, the port closes.
    port.send({ type: "shutdown" });
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    await expect(fetch(url)).rejects.toThrow();
    expect(logger.level).toBe("silent");

    // The log has the story, and never the secret.
    const log = await readFile(join(base, "logs", "engine.log"), "utf8");
    expect(log).toContain("Engine listening");
    expect(log).toContain("Engine stopped");
    expect(log).not.toContain(TEST_SECRET);
  });

  it("reports a bad init as fatal and exits 1", async () => {
    const port = new FakePort();
    const exit = vi.fn();
    const start = vi.fn(startEngine);
    runEngineProcess(port, { exit, start, stderr: () => undefined });

    port.send({ ...testInitMessage(base), logLevel: "loud" });

    const fatal = await port.waitFor("fatal");
    expect(fatal.message).toContain("logLevel");
    expect(fatal.message).not.toContain(TEST_SECRET);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("reports a failed start as fatal and exits 1", async () => {
    const port = new FakePort();
    const exit = vi.fn();
    runEngineProcess(port, {
      exit,
      stderr: () => undefined,
      start: () => Promise.reject(new Error("no room on disk")),
    });

    port.send(testInitMessage(base));

    const fatal = await port.waitFor("fatal");
    expect(fatal.message).toBe("The engine couldn't start: no room on disk");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it("exits 0 on a shutdown before init", async () => {
    const port = new FakePort();
    const exit = vi.fn();
    runEngineProcess(port, { exit, stderr: () => undefined });

    port.send({ type: "shutdown" });

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(port.posted).toEqual([]);
  });

  it("applies a config that came while starting, and ignores a second init", async () => {
    const port = new FakePort();
    const exit = vi.fn();
    let engine: RunningEngine | null = null;
    runEngineProcess(port, {
      exit,
      stderr: () => undefined,
      start: async (...args) => {
        engine = await startEngine(...args);
        return engine;
      },
    });
    const config = {
      ...testInitMessage(base).config,
      maxConnections: 7,
    };

    port.send(testInitMessage(base));
    port.send({ type: "config", config });
    port.send(testInitMessage(base));
    await port.waitFor("ready");

    expect(getRuntime().config.maxConnections).toBe(7);
    expect(port.posted.filter((m) => m.type === "ready")).toHaveLength(1);

    port.send({ type: "shutdown" });
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });
});

describe("startEngine", () => {
  it("never creates a missing video folder (an unplugged drive), and says so on add", async () => {
    const cacheDir = join(base, "Volumes", "Drive", "Streamy");
    const init = testInitMessage(base, {
      config: { ...testInitMessage(base).config, cacheDir },
    });

    const engine = await startEngine(init, { post: () => undefined });
    expect(existsSync(join(base, "Volumes"))).toBe(false);

    const res = await fetch(`http://127.0.0.1:${engine.port}/v1/torrents`, {
      method: "POST",
      headers: {
        [ENGINE_SECRET_HEADER]: TEST_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ magnet: "a".repeat(40) }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The video folder isn't available. Is the drive connected?",
      },
    });
    expect(existsSync(join(base, "Volumes"))).toBe(false);

    // Settings point somewhere missing too: still nothing created.
    engine.applyConfig({ ...init.config, cacheDir: join(base, "gone") });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(base, "gone"))).toBe(false);
    await engine.shutdown();
  });

  it("cleans nothing in a folder that isn't marked as Streamy's", async () => {
    const cacheDir = join(base, "cache");
    await mkdir(join(cacheDir, "playback", "someone-elses"), {
      recursive: true,
    });

    const engine = await startEngine(testInitMessage(base), {
      post: () => undefined,
    });

    expect(existsSync(join(cacheDir, "playback", "someone-elses"))).toBe(true);
    expect(existsSync(join(cacheDir, "torrents"))).toBe(false);
    await engine.shutdown();
  });

  it("opens the library before listening and closes it at shutdown", async () => {
    const init = testInitMessage(base);
    await makeVideoFolder(init.config.cacheDir);
    // Half-written by a crash: removed at start.
    const torrents = join(init.config.cacheDir, "torrents");
    await mkdir(torrents, { recursive: true });
    const temp = join(torrents, `.${"a".repeat(40)}.streamy.json.1-ab.tmp`);
    await writeFile(temp, "{");

    const engine = await startEngine(init, { post: () => undefined });
    const get = (path: string) =>
      fetch(`http://127.0.0.1:${engine.port}${path}`, {
        headers: { [ENGINE_SECRET_HEADER]: TEST_SECRET },
      });

    expect(existsSync(temp)).toBe(false);
    expect(await (await get("/v1/library")).json()).toEqual({
      continueWatching: [],
      recent: [],
    });
    expect(
      ((await (await get("/v1/health")).json()) as Health).lowDiskSpace,
    ).toBe(false);
    expect((await get("/v1/cache")).status).toBe(200);
    expect(engineServices()?.library.persistent).toBe(true);

    await engine.shutdown();

    expect(engineServices()).toBeNull();
    // Closed: another connection gets the write lock at once.
    const db = new DatabaseSync(join(base, "data", "library.db"), {
      timeout: 0,
    });
    db.exec("BEGIN IMMEDIATE; COMMIT");
    db.close();
  });

  it("still starts when library.db can't be used, with this run's history in memory", async () => {
    await mkdir(join(base, "data"), { recursive: true });
    const newer = new DatabaseSync(join(base, "data", "library.db"));
    newer.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    newer.close();

    const engine = await startEngine(testInitMessage(base), {
      post: () => undefined,
    });

    expect(engineServices()?.library.persistent).toBe(false);
    const res = await fetch(`http://127.0.0.1:${engine.port}/v1/library`, {
      headers: { [ENGINE_SECRET_HEADER]: TEST_SECRET },
    });
    expect(res.status).toBe(200);
    await engine.shutdown();
  });

  it("cuts open connections at shutdown, quickly", async () => {
    const engine = await startEngine(testInitMessage(base), {
      post: () => undefined,
    });
    // A kept-alive connection: server.close() alone could wait on it.
    const agent = new Agent({ keepAlive: true });
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest(
        { host: "127.0.0.1", port: engine.port, path: "/nope", agent },
        resolve,
      )
        .on("error", reject)
        .end();
    });
    res.resume();
    await once(res, "end");
    const [socket] = Object.values(agent.sockets).flat();
    const closed = socket ? once(socket, "close") : Promise.resolve();

    const started = Date.now();
    await engine.shutdown({ deadlineMs: 500 });

    expect(Date.now() - started).toBeLessThan(2_000);
    await closed;
    agent.destroy();
  });
});
