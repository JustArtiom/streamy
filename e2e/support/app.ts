import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  _electron,
  type ElectronApplication,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type {
  FileProgress,
  Library,
  LibraryTorrentDetail,
  TorrentDetail,
} from "../../src/shared/engine-api";
import { BUILD_DIR } from "./paths";
import {
  isAlive,
  killHard,
  type ProcessInfo,
  processesMentioning,
} from "./processes";
import type { Workspace } from "./workspace";

// Starts the built app the way people run it (Electron, the engine, the
// bundled ffmpeg), hidden and muted by test mode (src/main/test-mode.ts),
// with the test's own profile. close() quits it like a person would, then
// makes sure every process it started is gone.

/** A graceful quit stops the engine first (up to ~6 s, see host.ts). */
const QUIT_TIMEOUT_MS = 20_000;
/** After quitting, how long its processes get to disappear. */
const EXIT_TIMEOUT_MS = 10_000;

/** What Electron printed: kept for the failure report. */
const MAX_OUTPUT_LINES = 500;

export class StreamyApp {
  readonly electron: ElectronApplication;
  /** The main window. */
  readonly page: Page;
  readonly workspace: Workspace;
  /** Electron's main process. */
  readonly pid: number;
  readonly #output: string[];
  readonly #tracePath: string;
  #closing: Promise<void> | null = null;

  private constructor(options: {
    electron: ElectronApplication;
    page: Page;
    workspace: Workspace;
    output: string[];
    tracePath: string;
  }) {
    this.electron = options.electron;
    this.page = options.page;
    this.workspace = options.workspace;
    this.pid = options.electron.process().pid ?? 0;
    this.#output = options.output;
    this.#tracePath = options.tracePath;
  }

  /**
   * Starts Streamy with the workspace's profile and waits for Home. `name`
   * tells launches of one test apart in its trace files.
   */
  static async launch(
    workspace: Workspace,
    testInfo: TestInfo,
    name: string,
  ): Promise<StreamyApp> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    // Nothing from the shell may change how the app runs.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    delete env.STREAMY_SMOKE;
    env.STREAMY_TEST_MODE = "1";
    env.STREAMY_FFMPEG_DIR = workspace.bin;

    const electron = await _electron.launch({
      args: [BUILD_DIR, `--user-data-dir=${workspace.profile}`],
      env,
      cwd: workspace.root,
      // Linux: keep Chromium's sandbox on, like the real app (CI allows the
      // user namespaces it needs). E2E_NO_SANDBOX=1 for machines that don't.
      chromiumSandbox: process.env.E2E_NO_SANDBOX !== "1",
      timeout: 30_000,
    });

    const output: string[] = [];
    const keep = (stream: string) => (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) output.push(`[${stream}] ${line}`);
      }
      output.splice(0, Math.max(0, output.length - MAX_OUTPUT_LINES));
    };
    electron.process().stdout?.on("data", keep("stdout"));
    electron.process().stderr?.on("data", keep("stderr"));

    const tracePath = testInfo.outputPath(`trace-${name}.zip`);
    try {
      await electron.context().tracing.start({
        title: `${testInfo.title} (${name})`,
        screenshots: true,
        snapshots: true,
      });
      const page = await electron.firstWindow();
      page.on("console", (message) => {
        if (message.type() === "error")
          output.push(`[console] ${message.text()}`);
      });
      await watchForShownWindows(electron);
      const app = new StreamyApp({
        electron,
        page,
        workspace,
        output,
        tracePath,
      });
      await expect(
        page.getByRole("heading", { name: "What do you want to watch?" }),
      ).toBeVisible();
      await app.waitForEngine();
      return app;
    } catch (error) {
      // Never leave a half-started app behind.
      killHard(electron.process().pid ?? 0);
      await killLeftovers(workspace.root);
      throw error;
    }
  }

  /**
   * Fetches app://streamy/api<path> the way the UI does: through main's
   * app:// handler and engine proxy. The body is parsed as JSON (null when
   * it isn't JSON, e.g. video bytes), typed as the caller says (the types
   * of src/shared/engine-api.ts): checking it is what tests are for.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
  async api<T = unknown>(
    path: string,
    init: { method?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: T }> {
    return this.electron.evaluate(
      async ({ net }, { path, init }) => {
        const response = await net.fetch(`app://streamy/api${path}`, init);
        const text = await response.text();
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON.
        }
        return { status: response.status, body: body as T };
      },
      { path, init },
    );
  }

  /** Waits until the engine answers through the app (/v1/health). */
  async waitForEngine(): Promise<void> {
    await expect
      .poll(async () => (await this.api("/v1/health")).status, {
        message: "The engine should start",
        timeout: 30_000,
      })
      .toBe(200);
  }

  /** The engine's view of a torrent (404 while it isn't open). */
  async torrent(
    infoHash: string,
  ): Promise<{ status: number; torrent: TorrentDetail | null }> {
    const { status, body } = await this.api<{ torrent?: TorrentDetail } | null>(
      `/v1/torrents/${infoHash}`,
    );
    return { status, torrent: body?.torrent ?? null };
  }

  /** Continue watching and Recent, as the engine's library has them. */
  async library(): Promise<Library> {
    const { status, body } = await this.api<Library>("/v1/library");
    if (status !== 200) throw new Error(`/v1/library answered ${status}`);
    return body;
  }

  /** What the library saved for one file (position, tracks), if anything. */
  async savedProgress(
    infoHash: string,
    fileIndex: number,
  ): Promise<FileProgress | null> {
    const { status, body } = await this.api<LibraryTorrentDetail>(
      `/v1/library/${infoHash}`,
    );
    if (status !== 200) return null;
    return body.progress.find((item) => item.fileIndex === fileIndex) ?? null;
  }

  /** A file of an open torrent, by name. */
  async fileIndex(infoHash: string, name: string): Promise<number> {
    const { torrent } = await this.torrent(infoHash);
    const file = torrent?.files.find((item) => item.name === name);
    if (!file) throw new Error(`${name} isn't in the open torrent`);
    return file.index;
  }

  /** The engine's process id; null while it's being restarted. */
  async enginePid(): Promise<number | null> {
    return this.electron.evaluate(({ app }) => {
      const engine = app
        .getAppMetrics()
        .find(
          (metric) =>
            metric.type === "Utility" && metric.name === "Streamy Engine",
        );
      return engine?.pid ?? null;
    });
  }

  /** ffmpeg/ffprobe processes this app started that are still running. */
  async mediaProcesses(): Promise<ProcessInfo[]> {
    return processesMentioning(this.workspace.bin);
  }

  /** Every window: never shown, always muted (test mode). */
  async windows(): Promise<{ visible: boolean; muted: boolean }[]> {
    return this.electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        muted: window.webContents.isAudioMuted(),
      })),
    );
  }

  /** Lines of the profile's main.log or engine.log (JSON, one per line). */
  logLines(file: "main.log" | "engine.log"): Record<string, unknown>[] {
    let text: string;
    try {
      text = readFileSync(join(this.workspace.logs, file), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** What Electron printed (for failure reports). */
  output(): string {
    return this.#output.join("\n");
  }

  /** Where this launch's trace is saved when it closes. */
  get tracePath(): string {
    return this.#tracePath;
  }

  get closed(): boolean {
    return this.#closing !== null;
  }

  /**
   * Quits like a person would (the engine gets its clean shutdown), then
   * waits for every process of this launch to be gone: Electron and its
   * helpers, the engine, ffmpeg. Anything still there after that is killed,
   * and close() fails: a test must never leave processes behind.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const known = await this.#knownPids();
    // Test mode's promise, checked for every launch: nothing appeared on
    // screen, nothing could be heard.
    const discreet = await this.electron
      .evaluate(({ BrowserWindow }) => {
        const { e2eShown } = globalThis as { e2eShown?: boolean };
        return (
          e2eShown === false &&
          BrowserWindow.getAllWindows().every(
            (window) =>
              !window.isVisible() && window.webContents.isAudioMuted(),
          )
        );
      })
      .catch(() => true); // Already gone (e.g. crashed): nothing to see.
    await this.electron
      .context()
      .tracing.stop({ path: this.#tracePath })
      .catch(() => undefined);

    let quitError: unknown = null;
    try {
      await withTimeout(this.electron.close(), QUIT_TIMEOUT_MS, "quitting");
    } catch (error) {
      quitError = error;
    }

    const leftovers = await waitForExit(this.workspace.root, known);
    if (leftovers.length > 0) {
      for (const { pid } of leftovers) killHard(pid);
      throw new Error(
        `Streamy left processes behind:\n${leftovers
          .map(({ pid, args }) => `  ${pid} ${args.slice(0, 200)}`)
          .join("\n")}`,
      );
    }
    if (quitError !== null) {
      throw quitError instanceof Error
        ? quitError
        : new Error("Quitting failed", { cause: quitError });
    }
    if (!discreet) {
      throw new Error(
        "A window was shown or not muted: test mode must keep every window hidden and silent",
      );
    }
  }

  /** Electron's processes now (main, helpers, the engine). */
  async #knownPids(): Promise<number[]> {
    const fromMetrics = await this.electron
      .evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.pid))
      .catch(() => [] as number[]);
    return [...new Set([this.pid, ...fromMetrics])].filter((pid) => pid > 0);
  }
}

/**
 * Notes in main (globalThis.e2eShown) if any window is ever shown, even for
 * a moment. Checked when the app closes.
 */
async function watchForShownWindows(
  electron: ElectronApplication,
): Promise<void> {
  await electron.evaluate(({ app, BrowserWindow }) => {
    const state = globalThis as { e2eShown?: boolean };
    state.e2eShown = false;
    const watch = (window: Electron.BrowserWindow) => {
      if (window.isVisible()) state.e2eShown = true;
      window.on("show", () => {
        state.e2eShown = true;
      });
    };
    BrowserWindow.getAllWindows().forEach(watch);
    app.on("browser-window-created", (_event, window) => {
      watch(window);
    });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out ${what} after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits until no process mentions `root` and none of `pids` is alive.
 * Returns whatever is still running after EXIT_TIMEOUT_MS.
 */
async function waitForExit(
  root: string,
  pids: number[],
): Promise<ProcessInfo[]> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  for (;;) {
    const mentioning = await processesMentioning(root);
    const seen = new Set(mentioning.map(({ pid }) => pid));
    const alive = pids
      .filter((pid) => !seen.has(pid) && isAlive(pid))
      .map((pid) => ({ pid, args: "(an Electron process of this launch)" }));
    const left = [...mentioning, ...alive];
    if (left.length === 0 || Date.now() > deadline) return left;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Kills every process that mentions `root` (after a failed launch). */
export async function killLeftovers(root: string): Promise<ProcessInfo[]> {
  const leftovers = await processesMentioning(root);
  for (const { pid } of leftovers) killHard(pid);
  return leftovers;
}
