import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../shared/api";
import { silentLogger } from "../logs";
import { GitHubCheckError } from "./github";
import type { UpdateMode } from "./mode";
import {
  CHECK_INTERVAL_MS,
  classifyFailure,
  FIRST_CHECK_DELAY_MS,
  INSTALL_QUIT_TIMEOUT_MS,
  PREPARE_TIMEOUT_MS,
  UPDATE_MESSAGES,
  type UpdateBackend,
  type UpdateCheckResult,
  Updater,
  type UpdaterOptions,
} from "./updater";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");

/** Stands in for electron-updater's autoUpdater. */
class FakeBackend extends EventEmitter implements UpdateBackend {
  checkForUpdates = vi.fn((): Promise<UpdateCheckResult | null> =>
    Promise.resolve(upToDate()),
  );
  quitAndInstall = vi.fn(
    (_isSilent?: boolean, _isForceRunAfter?: boolean): void => undefined,
  );

  progress(percent: number) {
    this.emit("download-progress", { percent });
  }
}

function upToDate(version = "0.1.0"): UpdateCheckResult {
  return { isUpdateAvailable: false, updateInfo: { version } };
}

/** A check that found `version` and started downloading it. */
function found(version: string) {
  const download = Promise.withResolvers<string[]>();
  const result: UpdateCheckResult = {
    isUpdateAvailable: true,
    updateInfo: { version },
    downloadPromise: download.promise,
  };
  return { result, download };
}

function withCode(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function setup(mode: UpdateMode, overrides: Partial<UpdaterOptions> = {}) {
  const backend = new FakeBackend();
  let quitting = false;
  // The fakes the tests look at (overrides replace them in the updater).
  const options = {
    createBackend: vi.fn(() => backend),
    fetch: vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 })),
    ),
    openExternal: vi.fn((_url: string) => Promise.resolve()),
    beforeInstall: vi.fn((): Promise<void> => Promise.resolve()),
    quit: vi.fn(() => {
      quitting = true;
    }),
  };
  const updater = new Updater({
    mode,
    automaticChecks: true,
    currentVersion: "0.1.0",
    log: silentLogger(),
    isQuitting: () => quitting,
    now: () => NOW,
    ...options,
    ...overrides,
  });
  const statuses: UpdateStatus[] = [];
  updater.onStatusChange((status) => statuses.push(status));
  return {
    updater,
    backend,
    options,
    statuses,
    startQuitting: () => {
      quitting = true;
    },
  };
}

/** Gets an "auto" updater to "ready" for `version`. */
async function readyUpdater(version = "0.2.0") {
  const env = setup("auto");
  const { result, download } = found(version);
  env.backend.checkForUpdates.mockResolvedValueOnce(result);
  await env.updater.check();
  download.resolve(["/tmp/Streamy-setup.exe"]);
  await vi.waitFor(() => {
    expect(env.updater.status().state).toBe("ready");
  });
  return env;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("when it checks", () => {
  it("first 30 seconds after start, then every 6 hours", async () => {
    const { updater, backend } = setup("auto");
    updater.start();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checkForUpdates).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(3);
    updater.dispose();
  });

  it("checks only when asked while automatic checks are off", async () => {
    const { updater, backend } = setup("auto", { automaticChecks: false });
    updater.start();

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();

    // Settings → "Check for updates" still works.
    await updater.check();
    expect(backend.checkForUpdates).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checkForUpdates).toHaveBeenCalledOnce();
    updater.dispose();
  });

  it("stops checking when the setting is turned off, and starts again when it's on", async () => {
    const { updater, backend } = setup("auto");
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);

    updater.setAutomaticChecks(false);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);

    updater.setAutomaticChecks(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(3);
    updater.dispose();
  });

  it("doesn't check twice when the setting flips during a check", async () => {
    const { updater, backend } = setup("auto");
    const slow = Promise.withResolvers<UpdateCheckResult | null>();
    backend.checkForUpdates.mockReturnValueOnce(slow.promise);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);

    updater.setAutomaticChecks(false);
    updater.setAutomaticChecks(true); // schedules the next one
    slow.resolve(upToDate());
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.dispose();
  });

  it("never schedules checks for a build that can't update", async () => {
    const { updater, backend, options } = setup("unsupported");
    updater.start();
    updater.setAutomaticChecks(false);
    updater.setAutomaticChecks(true);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it("keeps checking after a failed check", async () => {
    const { updater, backend } = setup("auto");
    backend.checkForUpdates.mockRejectedValueOnce(
      new Error("net::ERR_INTERNET_DISCONNECTED"),
    );
    updater.start();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(updater.status()).toEqual({
      state: "error",
      message: UPDATE_MESSAGES.offline,
    });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(updater.status()).toEqual({
      state: "idle",
      checkedAt: new Date(NOW).toISOString(),
    });
    updater.dispose();
  });

  it("stops checking once disposed (Streamy quits)", async () => {
    const { updater, backend } = setup("auto");
    updater.start();
    updater.dispose();

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
  });

  it("asks once when asked twice at the same time", async () => {
    const { updater, backend } = setup("auto");

    const [first, second] = await Promise.all([
      updater.check(),
      updater.check(),
    ]);

    expect(backend.checkForUpdates).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
  });
});

describe("Windows and AppImage (auto)", () => {
  it("says when Streamy is up to date, and when it last checked", async () => {
    const { updater, statuses } = setup("auto");
    expect(updater.status()).toEqual({ state: "idle", checkedAt: null });

    const status = await updater.check();

    const idle = { state: "idle", checkedAt: "2026-10-21T12:00:00.000Z" };
    expect(status).toEqual(idle);
    expect(statuses).toEqual([{ state: "checking" }, idle]);
  });

  it("downloads a new version in the background, then it's ready", async () => {
    const { updater, backend, statuses } = setup("auto");
    const { result, download } = found("0.2.0");
    backend.checkForUpdates.mockResolvedValueOnce(result);

    expect(await updater.check()).toEqual({
      state: "downloading",
      version: "0.2.0",
      percent: 0,
    });
    backend.progress(12.4);
    backend.progress(12.9); // same whole percent: no news
    backend.progress(57.5);
    download.resolve(["/tmp/update.exe"]);
    await vi.waitFor(() => {
      expect(updater.status()).toEqual({ state: "ready", version: "0.2.0" });
    });

    expect(statuses).toEqual([
      { state: "checking" },
      { state: "downloading", version: "0.2.0", percent: 0 },
      { state: "downloading", version: "0.2.0", percent: 12 },
      { state: "downloading", version: "0.2.0", percent: 57 },
      { state: "ready", version: "0.2.0" },
    ]);
  });

  it("doesn't check again while downloading or once ready", async () => {
    const { updater, backend } = setup("auto");
    const { result, download } = found("0.2.0");
    backend.checkForUpdates.mockResolvedValueOnce(result);
    await updater.check();

    expect((await updater.check()).state).toBe("downloading");
    download.resolve([]);
    await vi.waitFor(() => {
      expect(updater.status().state).toBe("ready");
    });
    expect((await updater.check()).state).toBe("ready");
    expect(backend.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("says when the download failed", async () => {
    const { updater, backend } = setup("auto");
    const { result, download } = found("0.2.0");
    backend.checkForUpdates.mockResolvedValueOnce(result);
    await updater.check();

    download.reject(new Error("sha512 checksum mismatch"));

    await vi.waitFor(() => {
      expect(updater.status()).toEqual({
        state: "error",
        message: UPDATE_MESSAGES.download,
      });
    });
  });

  it("counts no release yet as up to date", async () => {
    const { updater, backend } = setup("auto");
    backend.checkForUpdates.mockRejectedValueOnce(
      withCode("No published versions on GitHub", "ERR_XML_MISSED_ELEMENT"),
    );

    expect((await updater.check()).state).toBe("idle");
  });

  it.each([
    [new Error("net::ERR_NAME_NOT_RESOLVED"), UPDATE_MESSAGES.offline],
    [
      Object.assign(new Error("403 Forbidden"), { statusCode: 403 }),
      UPDATE_MESSAGES.busy,
    ],
    [new Error("Something odd"), UPDATE_MESSAGES.check],
  ])("explains a failed check: %s", async (error, message) => {
    const { updater, backend } = setup("auto");
    backend.checkForUpdates.mockRejectedValueOnce(error);

    expect(await updater.check()).toEqual({ state: "error", message });
  });

  it("loads electron-updater only when it first checks", async () => {
    const { updater, options } = setup("auto");
    updater.start();
    expect(options.createBackend).not.toHaveBeenCalled();

    await updater.check();
    await updater.check();
    expect(options.createBackend).toHaveBeenCalledOnce();
    updater.dispose();
  });

  it("says so if electron-updater can't start", async () => {
    const { updater } = setup("auto", {
      createBackend: () => {
        throw new Error("App version is not a valid semver version");
      },
    });

    expect(await updater.check()).toEqual({
      state: "error",
      message: UPDATE_MESSAGES.check,
    });
  });
});

describe("Restart to update", () => {
  it("stops the engine first, then quits and installs", async () => {
    const { updater, backend, options } = await readyUpdater();
    const order: string[] = [];
    options.beforeInstall.mockImplementation(() => {
      order.push("stop engine");
      return Promise.resolve();
    });
    backend.quitAndInstall.mockImplementation(() => {
      order.push("quit and install");
    });

    await updater.install();

    expect(order).toEqual(["stop engine", "quit and install"]);
    // Not silent (Windows shows the installer's progress), and reopens Streamy.
    expect(backend.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("installs even if stopping the engine fails or hangs", async () => {
    const failing = await readyUpdater();
    failing.options.beforeInstall.mockRejectedValue(new Error("Stuck"));
    await failing.updater.install();
    expect(failing.backend.quitAndInstall).toHaveBeenCalledOnce();

    const hanging = await readyUpdater();
    hanging.options.beforeInstall.mockReturnValue(new Promise<void>(() => {}));
    void hanging.updater.install();
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS - 1);
    expect(hanging.backend.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hanging.backend.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("happens once, however often it's clicked", async () => {
    const { updater, backend, options } = await readyUpdater();

    await Promise.all([updater.install(), updater.install()]);
    await updater.install();

    expect(options.beforeInstall).toHaveBeenCalledOnce();
    expect(backend.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("does nothing when no update is ready", async () => {
    const { updater, backend, options } = setup("auto");
    await updater.check();

    await updater.install();

    expect(options.beforeInstall).not.toHaveBeenCalled();
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
  });

  it("quits anyway if the installer didn't take over", async () => {
    const { updater, options } = await readyUpdater();

    await updater.install();
    await vi.advanceTimersByTimeAsync(INSTALL_QUIT_TIMEOUT_MS);

    expect(options.quit).toHaveBeenCalledOnce();
  });

  it("leaves quitting to electron-updater when it works", async () => {
    const { updater, backend, options, startQuitting } = await readyUpdater();
    backend.quitAndInstall.mockImplementation(startQuitting);

    await updater.install();
    await vi.advanceTimersByTimeAsync(INSTALL_QUIT_TIMEOUT_MS);

    expect(options.quit).not.toHaveBeenCalled();
  });

  it("stops the regular checks", async () => {
    const { updater, backend, startQuitting } = await readyUpdater();
    backend.quitAndInstall.mockImplementation(startQuitting);
    updater.start();

    await updater.install();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);

    expect(backend.checkForUpdates).toHaveBeenCalledOnce(); // readyUpdater's
  });
});

describe("macOS (notify)", () => {
  const release = (tag: string) =>
    vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(Response.json({ tag_name: tag })),
    );

  it("says a newer version is available, to download by hand", async () => {
    const { updater, backend, options } = setup("notify", {
      fetch: release("v0.2.0"),
    });

    expect(await updater.check()).toEqual({
      state: "available",
      version: "0.2.0",
      canInstall: false,
    });
    expect(options.createBackend).not.toHaveBeenCalled();
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
  });

  it("opens that release's page in the browser", async () => {
    const { updater, options } = setup("notify", { fetch: release("v0.2.0") });
    await updater.check();

    expect(await updater.openReleasePage()).toEqual({ status: "ok" });
    expect(options.openExternal).toHaveBeenCalledWith(
      "https://github.com/JustArtiom/streamy/releases/tag/v0.2.0",
    );
  });

  it.each(["v0.1.0", "v0.0.9", "v0.1.0-beta.1"])(
    "is up to date when the newest is %s",
    async (tag) => {
      const { updater } = setup("notify", { fetch: release(tag) });

      expect((await updater.check()).state).toBe("idle");
    },
  );

  it("is up to date while there's no release yet (404)", async () => {
    const { updater } = setup("notify");

    expect(await updater.check()).toEqual({
      state: "idle",
      checkedAt: new Date(NOW).toISOString(),
    });
  });

  it("keeps showing a known new version when a later check fails", async () => {
    const fetch = release("v0.2.0");
    const { updater, statuses } = setup("notify", { fetch });
    await updater.check();
    fetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await updater.check();

    const available = {
      state: "available",
      version: "0.2.0",
      canInstall: false,
    };
    expect(updater.status()).toEqual(available);
    // No "checking" in between: the notice doesn't blink.
    expect(statuses).toEqual([{ state: "checking" }, available]);
  });

  it.each([
    [new TypeError("fetch failed"), UPDATE_MESSAGES.offline],
    [
      Response.json({ message: "rate limit" }, { status: 403 }),
      UPDATE_MESSAGES.busy,
    ],
    [new Response("oops", { status: 502 }), UPDATE_MESSAGES.check],
  ])("explains a failed check (%s)", async (outcome, message) => {
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      outcome instanceof Response
        ? Promise.resolve(outcome)
        : Promise.reject(outcome),
    );
    const { updater } = setup("notify", { fetch });

    expect(await updater.check()).toEqual({ state: "error", message });
  });

  it("opens the releases list before it knows of a release", async () => {
    const { updater, options } = setup("notify");

    await updater.openReleasePage();

    expect(options.openExternal).toHaveBeenCalledWith(
      "https://github.com/JustArtiom/streamy/releases/latest",
    );
  });

  it("says when the browser couldn't be opened", async () => {
    const { updater, options } = setup("notify");
    options.openExternal.mockRejectedValueOnce(new Error("No browser"));

    expect(await updater.openReleasePage()).toEqual({
      status: "error",
      message: UPDATE_MESSAGES.browser,
    });
  });

  it("has nothing to install", async () => {
    const { updater, options } = setup("notify", { fetch: release("v0.2.0") });
    await updater.check();

    await updater.install();

    expect(options.beforeInstall).not.toHaveBeenCalled();
  });
});

describe("dev builds, the .deb, the smoke test (unsupported)", () => {
  it("never checks", async () => {
    const { updater, backend, options } = setup("unsupported");
    updater.start();

    expect(await updater.check()).toEqual({ state: "unsupported" });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
    expect(options.createBackend).not.toHaveBeenCalled();
  });

  it("can still open the releases page", async () => {
    const { updater, options } = setup("unsupported");

    expect(await updater.openReleasePage()).toEqual({ status: "ok" });
    expect(options.openExternal).toHaveBeenCalledWith(
      "https://github.com/JustArtiom/streamy/releases/latest",
    );
  });
});

describe("classifyFailure (electron-updater's errors)", () => {
  it.each([
    [withCode("x", "ERR_UPDATER_NO_PUBLISHED_VERSIONS"), "no-release"],
    [
      withCode("No latest.yml", "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"),
      "no-release",
    ],
    [
      withCode(
        "Unable to find latest version on GitHub: HttpError: 404 \n…",
        "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      ),
      "no-release",
    ],
    [
      withCode(
        "Unable to find latest version on GitHub: Error: net::ERR_INTERNET_DISCONNECTED",
        "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      ),
      "offline",
    ],
    [
      withCode(
        "Unable to find latest version on GitHub: HttpError: 429 Too Many Requests",
        "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      ),
      "busy",
    ],
    [Object.assign(new Error("503"), { statusCode: 503 }), "busy"],
    [new Error("getaddrinfo ENOTFOUND github.com"), "offline"],
    [new Error("net::ERR_CONNECTION_RESET"), "offline"],
    [new GitHubCheckError("busy", "403"), "busy"],
    [new GitHubCheckError("unexpected", "?"), "other"],
    [new Error("sha512 checksum mismatch"), "other"],
    ["a string", "other"],
  ])("%s → %s", (error, kind) => {
    expect(classifyFailure(error)).toBe(kind);
  });
});
