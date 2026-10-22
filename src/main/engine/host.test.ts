import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineStatus } from "../../shared/api";
import {
  ENGINE_READY_TIMEOUT_MS,
  ENGINE_SHUTDOWN_TIMEOUT_MS,
  type EngineConfig,
} from "../../shared/engine-protocol";
import {
  electron,
  resetFakeElectron,
  utilityProcesses,
} from "../test/fake-electron";
import type { FakeUtilityProcess } from "../test/fake-utility-process";
import {
  EngineHost,
  FAILED_RETRY_MS,
  KILL_GRACE_MS,
  parseTasklistImage,
  STABLE_AFTER_MS,
} from "./host";

vi.mock(
  "electron",
  async () => (await import("../test/fake-electron")).electron,
);

const CONFIG: EngineConfig = {
  cacheDir: "/cache",
  cacheLimitBytes: 20_000_000_000,
  hardwareEncoding: "auto",
  downloadLimit: null,
  uploadLimit: null,
  keepSharingMinutes: 10,
  maxConnections: 100,
};

/** A logger whose lines the test can read. */
function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { log: pino({ level: "debug" }, stream), text: () => lines.join("") };
}

function setup() {
  const killPid = vi.fn<(pid: number) => void>();
  const logger = captureLogger();
  const host = new EngineHost({
    entryPath: "/app/out/main/chunks/engine.js",
    init: () => ({
      config: CONFIG,
      dataDir: "/data",
      logsDir: "/logs",
      ffmpegPath: "/ffmpeg/ffmpeg",
      ffprobePath: "/ffmpeg/ffprobe",
      logLevel: "info",
      appVersion: "1.2.3",
    }),
    log: logger.log,
    killPid,
  });
  const statuses: EngineStatus[] = [];
  host.onStatusChange((status) => statuses.push(status));
  return { host, killPid, statuses, logText: logger.text };
}

/** The newest engine process. */
function engine(): FakeUtilityProcess {
  const latest = utilityProcesses.at(-1);
  if (!latest) throw new Error("No engine was started");
  return latest;
}

function secretOf(process: FakeUtilityProcess): string {
  const [init] = process.sent("init");
  if (typeof init?.secret !== "string") throw new Error("No init sent");
  return init.secret;
}

/** Lets queued microtasks run (fake exits happen in one). */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetFakeElectron();
});

describe("starting", () => {
  it("forks the engine, sends init with a secret, and waits for ready", () => {
    const { host, statuses } = setup();
    host.start();

    expect(electron.utilityProcess.fork).toHaveBeenCalledWith(
      "/app/out/main/chunks/engine.js",
      [],
      { serviceName: "Streamy Engine", stdio: "pipe" },
    );
    const [init] = engine().sent("init");
    expect(init).toMatchObject({
      config: CONFIG,
      dataDir: "/data",
      logsDir: "/logs",
      ffmpegPath: "/ffmpeg/ffmpeg",
      appVersion: "1.2.3",
    });
    expect(secretOf(engine())).toMatch(/^[0-9a-f]{64}$/);
    expect(host.status()).toEqual({ state: "starting", error: null });
    expect(host.connection()).toBeNull();

    engine().reply({ type: "ready", port: 4567 });

    expect(host.connection()).toEqual({
      port: 4567,
      secret: secretOf(engine()),
    });
    expect(statuses).toEqual([{ state: "running", error: null }]);
  });

  it("starts only once", () => {
    const { host } = setup();
    host.start();
    host.start();
    expect(utilityProcesses).toHaveLength(1);
  });

  it("lets other code wait until it's running", async () => {
    const { host } = setup();
    host.start();
    const waiting = host.whenRunning(10_000);

    engine().reply({ type: "ready", port: 4567 });

    await expect(waiting).resolves.toEqual({
      port: 4567,
      secret: secretOf(engine()),
    });
    await expect(host.whenRunning(1)).resolves.toMatchObject({ port: 4567 });
  });

  it("stops waiting after the timeout", async () => {
    const { host } = setup();
    host.start();
    const waiting = host.whenRunning(5_000);
    const check = expect(waiting).rejects.toThrow(/isn't running/);

    await vi.advanceTimersByTimeAsync(5_000);
    await check;
  });

  it("ignores messages it doesn't understand", () => {
    const { host } = setup();
    host.start();

    engine().reply({ type: "ready", port: "4567" });
    engine().reply({ type: "ready", port: 70_000 });
    engine().reply("hello");
    engine().reply({ type: "child", pid: -1, alive: true });
    engine().reply({ type: "something-new" });

    expect(host.connection()).toBeNull();
  });

  it("never writes the secret to the log", async () => {
    const { host, logText } = setup();
    host.start();
    engine().reply({ type: "ready", port: 4567 });
    engine().stderr.write("a warning from the engine\n");
    await flush();

    expect(logText()).toContain("a warning from the engine");
    expect(logText()).not.toContain(secretOf(engine()));
  });

  it("copies the engine's output into main.log", async () => {
    const { host, logText } = setup();
    host.start();

    engine().stdout.write("hello from stdout\n");
    engine().stderr.write("line one\r\nline two\n");
    await flush();

    expect(logText()).toContain("hello from stdout");
    expect(logText()).toContain("line one");
    expect(logText()).toContain("line two");
  });
});

describe("restarting", () => {
  it("starts again after 1 s, then 2 s", async () => {
    const { host, statuses } = setup();
    host.start();
    engine().reply({ type: "ready", port: 1 });

    engine().exit(1);
    expect(host.status()).toEqual({
      state: "restarting",
      error: "The playback engine stopped unexpectedly.",
    });
    expect(host.connection()).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(utilityProcesses).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(utilityProcesses).toHaveLength(2);

    engine().exit(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(utilityProcesses).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(utilityProcesses).toHaveLength(3);

    engine().reply({ type: "ready", port: 2 });
    expect(statuses).toEqual([
      { state: "running", error: null },
      {
        state: "restarting",
        error: "The playback engine stopped unexpectedly.",
      },
      // The second one never got ready.
      { state: "restarting", error: "The playback engine couldn't start." },
      { state: "running", error: null },
    ]);
    expect(host.status().error).toBeNull();
  });

  it("uses a new secret for every start", async () => {
    const { host } = setup();
    host.start();
    const first = secretOf(engine());
    engine().exit(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(secretOf(engine())).not.toBe(first);
  });

  it("waits 5 s after a third crash in a row that's spread out", async () => {
    const { host } = setup();
    host.start();
    for (const delay of [1_000, 2_000]) {
      engine().reply({ type: "ready", port: 1 });
      await vi.advanceTimersByTimeAsync(40_000); // runs, but not for long
      engine().exit(1);
      await vi.advanceTimersByTimeAsync(delay);
    }
    engine().reply({ type: "ready", port: 1 });
    await vi.advanceTimersByTimeAsync(40_000);
    engine().exit(1); // only 2 crashes in the last minute: not "failed"

    expect(host.status().state).toBe("restarting");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(utilityProcesses).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(utilityProcesses).toHaveLength(4);
  });

  it("goes back to short delays after running for a minute", async () => {
    const { host } = setup();
    host.start();
    engine().exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    engine().reply({ type: "ready", port: 1 });
    await vi.advanceTimersByTimeAsync(STABLE_AFTER_MS);

    engine().exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(utilityProcesses).toHaveLength(3);
  });

  it("gives up after three crashes in a minute, and tries again later", async () => {
    const { host, statuses } = setup();
    host.start();
    const waiting = host.whenRunning(120_000);
    const check = expect(waiting).rejects.toThrow("couldn't start");
    engine().exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    engine().exit(1);
    await vi.advanceTimersByTimeAsync(2_000);
    engine().exit(1);

    expect(host.status()).toEqual({
      state: "failed",
      error: "The playback engine couldn't start.",
    });
    await check;
    await expect(host.whenRunning(1_000)).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(FAILED_RETRY_MS - 1);
    expect(utilityProcesses).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(utilityProcesses).toHaveLength(4);
    expect(host.status().state).toBe("restarting");

    engine().reply({ type: "ready", port: 1 });
    expect(statuses.map((status) => status.state)).toEqual([
      "restarting",
      "failed",
      "restarting",
      "running",
    ]);
  });

  it("calls an exit before ready a failed start", () => {
    const { host } = setup();
    host.start();

    engine().exit(1);

    expect(host.status()).toEqual({
      state: "restarting",
      error: "The playback engine couldn't start.",
    });
  });

  it("logs the engine's own words, and shows people a plain sentence", async () => {
    const { host, logText } = setup();
    host.start();
    engine().reply({ type: "ready", port: 1 });

    const raw =
      "Unexpected error: Cannot read properties of undefined (reading 'files')";
    engine().reply({ type: "fatal", message: raw });
    engine().exit(1);
    await flush();

    expect(host.status()).toEqual({
      state: "restarting",
      error: "The playback engine stopped unexpectedly.",
    });
    expect(logText()).toContain("reading 'files'");
  });

  it("says it couldn't start when the engine gives up before ready", () => {
    const { host } = setup();
    host.start();

    engine().reply({
      type: "fatal",
      message: "EACCES: permission denied, open '/data/library.json'",
    });
    engine().exit(1);

    expect(host.status()).toEqual({
      state: "restarting",
      error: "The playback engine couldn't start.",
    });
  });

  it("kills an engine that doesn't get ready in time", async () => {
    const { host } = setup();
    host.start();
    const first = engine();

    await vi.advanceTimersByTimeAsync(ENGINE_READY_TIMEOUT_MS);

    expect(first.kill).toHaveBeenCalled();
    expect(host.status()).toEqual({
      state: "restarting",
      error: "The playback engine took too long to start.",
    });
  });

  it("counts a fork that throws as a crash", async () => {
    const { host } = setup();
    electron.utilityProcess.fork.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    host.start();

    expect(host.status().state).toBe("restarting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(utilityProcesses).toHaveLength(1);
  });
});

describe("leftover ffmpeg processes", () => {
  it("kills the ones still running when the engine dies", () => {
    const { host, killPid } = setup();
    host.start();
    engine().reply({ type: "ready", port: 1 });
    engine().reply({ type: "child", pid: 501, alive: true });
    engine().reply({ type: "child", pid: 502, alive: true });
    engine().reply({ type: "child", pid: 502, alive: false });

    engine().exit(1);

    expect(killPid.mock.calls).toEqual([[501]]);
  });

  it("is quiet about ones that are already gone", () => {
    const { host, killPid } = setup();
    killPid.mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    host.start();
    engine().reply({ type: "child", pid: 501, alive: true });

    expect(() => {
      engine().exit(1);
    }).not.toThrow();
  });

  it("also cleans up after a normal shutdown", async () => {
    const { host, killPid } = setup();
    host.start();
    engine().reply({ type: "ready", port: 1 });
    engine().reply({ type: "child", pid: 777, alive: true });

    const stopped = host.stop();
    engine().exit(0);
    await stopped;

    expect(killPid).toHaveBeenCalledWith(777);
  });
});

describe("settings", () => {
  it("sends changed settings to the engine", () => {
    const { host } = setup();
    host.start();
    const next = { ...CONFIG, maxConnections: 50 };

    host.configure(next);

    expect(engine().sent("config")).toEqual([{ type: "config", config: next }]);
  });

  it("has nothing to send while no engine runs", async () => {
    const { host } = setup();
    host.start();
    engine().exit(1);

    expect(() => {
      host.configure(CONFIG);
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine().sent("config")).toEqual([]);
  });
});

describe("stopping", () => {
  it("stops saying it's running (Restart to update: Streamy restarts)", async () => {
    const { host, statuses } = setup();
    host.start();
    engine().reply({ type: "ready", port: 1 });

    const stopped = host.stop();
    expect(host.status()).toEqual({ state: "restarting", error: null });
    expect(statuses.at(-1)).toEqual({ state: "restarting", error: null });
    engine().exit(0);
    await stopped;
    expect(host.status().state).toBe("restarting");
  });

  it("keeps a status that already says it isn't running", async () => {
    const { host } = setup();
    host.start();
    engine().exit(1);
    const before = host.status();

    await host.stop();

    expect(host.status()).toEqual(before);
  });

  it("asks the engine to shut down and never restarts it", async () => {
    const { host } = setup();
    host.start();
    engine().reply({ type: "ready", port: 1 });

    const stopped = host.stop();
    expect(engine().sent("shutdown")).toHaveLength(1);
    expect(host.connection()).toBeNull();
    engine().exit(0);
    await stopped;

    await vi.advanceTimersByTimeAsync(FAILED_RETRY_MS * 2);
    expect(utilityProcesses).toHaveLength(1);
    expect(host.hasProcess).toBe(false);
  });

  it("kills an engine that doesn't exit in time", async () => {
    const { host } = setup();
    host.start();
    engine().reply({ type: "ready", port: 1 });

    const stopped = host.stop();
    await vi.advanceTimersByTimeAsync(ENGINE_SHUTDOWN_TIMEOUT_MS - 1);
    expect(engine().kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(engine().kill).toHaveBeenCalled();

    await stopped;
    expect(host.hasProcess).toBe(false);
  });

  it("never hangs, even if the engine ignores being killed", async () => {
    const { host, killPid } = setup();
    host.start();
    const hung = engine();
    hung.exitsWhenKilled = false;
    const pid = hung.pid;

    const stopped = host.stop();
    let done = false;
    void stopped.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(ENGINE_SHUTDOWN_TIMEOUT_MS);
    expect(hung.kill).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(killPid).toHaveBeenCalledWith(pid);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);
  });

  it("finishes right away when no engine runs", async () => {
    const { host } = setup();
    await host.stop(); // never started

    const other = setup().host;
    other.start();
    engine().exit(1); // waiting to restart
    await other.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(utilityProcesses).toHaveLength(1);
  });

  it("tells anyone waiting for the engine that Streamy is quitting", async () => {
    const { host } = setup();
    host.start();
    const waiting = host.whenRunning(10_000);
    const check = expect(waiting).rejects.toThrow(/quitting/);

    void host.stop();

    await check;
    await expect(host.whenRunning(10)).rejects.toThrow(/quitting/);
  });
});

describe("parseTasklistImage (Windows: whose pid is it now?)", () => {
  it("reads the image name from tasklist's CSV line", () => {
    expect(
      parseTasklistImage('"ffmpeg.exe","4242","Console","1","52,340 K"\r\n'),
    ).toBe("ffmpeg.exe");
    expect(
      parseTasklistImage('"Code.exe","4242","Console","1","152,340 K"'),
    ).toBe("Code.exe");
  });

  it("finds nothing when no process has that pid", () => {
    expect(
      parseTasklistImage(
        "INFO: No tasks are running which match the specified criteria.\r\n",
      ),
    ).toBeNull();
    expect(parseTasklistImage("")).toBeNull();
  });
});
