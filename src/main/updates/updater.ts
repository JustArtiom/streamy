import type { UpdateStatus } from "../../shared/api";
import type { ActionResult } from "../../shared/settings";
import type { Logger } from "../logs";
import {
  compareVersions,
  fetchLatestRelease,
  GitHubCheckError,
  isOurReleasePage,
  LATEST_RELEASE_PAGE,
  releasePage,
} from "./github";
import type { UpdateMode } from "./mode";

// Keeps Streamy up to date (PLAN §11, Phase 5), in the mode from mode.ts:
//
// auto (Windows installer, Linux AppImage): electron-updater checks GitHub
//   Releases (latest.yml / latest-linux.yml), downloads a newer version in
//   the background, and then it's "ready": "Restart to update" installs it
//   now, and quitting Streamy installs it anyway (autoInstallOnAppQuit).
// notify (macOS): asks GitHub's API for the newest release; if it's newer,
//   "available" with canInstall: false, and the UI links to its page.
//
// Checks run 30 s after start and every 6 hours after that, and when the user
// asks (Settings → "Check for updates"). The checkForUpdates setting turns the
// automatic ones off (then Streamy contacts GitHub only when asked to).
// Failures are quiet: an "error" status that only Settings shows, and the
// next check tries again.

/** The first check waits for the app to settle (and not slow its start). */
export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** "Restart to update": how long stopping the engine may take. */
export const PREPARE_TIMEOUT_MS = 15_000;
/** "Restart to update": by then Streamy must have started quitting. */
export const INSTALL_QUIT_TIMEOUT_MS = 10_000;

/** What people see when something went wrong (Settings → Advanced). */
export const UPDATE_MESSAGES = {
  offline: "Couldn't reach GitHub. Check your internet connection.",
  busy: "GitHub is busy right now. Streamy will try again later.",
  check: "Couldn't check for updates. Streamy will try again later.",
  download: "Couldn't download the update. Streamy will try again later.",
  browser: "Couldn't open your browser.",
} as const;

/** What electron-updater's checkForUpdates() resolves to (the parts we use). */
export interface UpdateCheckResult {
  isUpdateAvailable: boolean;
  updateInfo: { version: string };
  /** Set when a download started (autoDownload). Resolves once it's done. */
  downloadPromise?: Promise<unknown> | null;
}

/** The parts of electron-updater's autoUpdater the updater uses. */
export interface UpdateBackend {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(
    event: "download-progress",
    listener: (progress: { percent: number }) => void,
  ): unknown;
}

export interface UpdaterOptions {
  mode: UpdateMode;
  /** The checkForUpdates setting at start (see setAutomaticChecks). */
  automaticChecks: boolean;
  /** app.getVersion() */
  currentVersion: string;
  log: Logger;
  /**
   * electron-updater's autoUpdater, set up for us ("auto" mode). Called once,
   * on the first check, so nothing loads before it's needed.
   */
  createBackend: () => UpdateBackend;
  /** Electron's net.fetch ("notify" mode asks GitHub's API). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** shell.openExternal */
  openExternal: (url: string) => Promise<void>;
  /** Stops the playback engine (see install()). */
  beforeInstall: () => Promise<void>;
  /** True once Streamy has started quitting. */
  isQuitting: () => boolean;
  /** app.quit() */
  quit: () => void;
  /** Date.now(), replaced in tests. */
  now?: () => number;
}

type Listener = (status: UpdateStatus) => void;

/** What kind of failure an error is, to pick the words for it. */
export type FailureKind = "no-release" | "offline" | "busy" | "other";

export class Updater {
  readonly #options: UpdaterOptions;
  readonly #listeners = new Set<Listener>();
  #status: UpdateStatus;
  #backend: UpdateBackend | null = null;
  #checking: Promise<UpdateStatus> | null = null;
  #checkTimer?: NodeJS.Timeout;
  #installTimer?: NodeJS.Timeout;
  #installing = false;
  #disposed = false;
  #started = false;
  #automatic: boolean;
  /** The newest release's tag ("v1.2.3"), for its page. */
  #releaseTag: string | null = null;

  constructor(options: UpdaterOptions) {
    this.#options = options;
    this.#automatic = options.automaticChecks;
    this.#status =
      options.mode === "unsupported"
        ? { state: "unsupported" }
        : { state: "idle", checkedAt: null };
  }

  status(): UpdateStatus {
    return { ...this.#status };
  }

  /** Calls `listener` after every status change. Returns an unsubscribe function. */
  onStatusChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Starts the regular checks (if they're on). Does nothing for
   * "unsupported".
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#automatic) this.#scheduleCheck(FIRST_CHECK_DELAY_MS);
  }

  /**
   * The checkForUpdates setting changed. Off: no more automatic checks (a
   * download already under way finishes). On again: the next check comes
   * FIRST_CHECK_DELAY_MS later, then every CHECK_INTERVAL_MS.
   */
  setAutomaticChecks(enabled: boolean): void {
    if (enabled === this.#automatic) return;
    this.#automatic = enabled;
    clearTimeout(this.#checkTimer);
    this.#checkTimer = undefined;
    this.#options.log.info({ enabled }, "Automatic update checks changed");
    if (enabled && this.#started) this.#scheduleCheck(FIRST_CHECK_DELAY_MS);
  }

  /**
   * Checks now, and resolves with the status once the check is done. While
   * a check runs, returns that one. Nothing to do while an update downloads
   * or waits for a restart.
   */
  check(): Promise<UpdateStatus> {
    const { state } = this.#status;
    if (
      state === "unsupported" ||
      state === "downloading" ||
      state === "ready" ||
      this.#installing ||
      this.#disposed
    ) {
      return Promise.resolve(this.status());
    }
    this.#checking ??= this.#runCheck().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  /**
   * "Restart to update". Stops the engine first: quitting normally waits for
   * it (engine/index.ts), but the Windows installer doesn't wait. About a
   * second after it starts, it closes Streamy by force, and an ffmpeg still
   * running would keep its files locked so they couldn't be replaced. With
   * the engine already stopped, Streamy quits at once.
   */
  async install(): Promise<void> {
    const { log } = this.#options;
    const status = this.#status;
    const backend = this.#backend;
    if (status.state !== "ready" || !backend) {
      log.warn({ state: status.state }, "No update is ready to install");
      return;
    }
    if (this.#installing) return;
    this.#installing = true;
    clearTimeout(this.#checkTimer);
    log.info({ version: status.version }, "Restarting to install the update");

    try {
      await withTimeout(this.#options.beforeInstall(), PREPARE_TIMEOUT_MS);
    } catch (error) {
      log.warn({ err: error }, "Could not stop the engine before updating");
    }

    try {
      // Not silent: Windows shows the installer's progress bar, so the
      // few seconds without a window make sense. Streamy opens again after.
      backend.quitAndInstall(false, true);
    } catch (error) {
      log.error({ err: error }, "Could not start the update");
    }

    // quitAndInstall quits by itself once the installer has started. If it
    // couldn't start it, Streamy would be left running without its engine:
    // quit anyway. (Quitting gives the update one more try.)
    this.#installTimer = setTimeout(() => {
      if (this.#options.isQuitting()) return;
      log.error("The update didn't start; quitting");
      this.#options.quit();
    }, INSTALL_QUIT_TIMEOUT_MS);
  }

  /** Opens the newest release's page (or the releases list) in the browser. */
  async openReleasePage(): Promise<ActionResult> {
    const { log } = this.#options;
    const url =
      (this.#releaseTag && releasePage(this.#releaseTag)) ??
      LATEST_RELEASE_PAGE;
    // Belt and braces: only ever our own releases on GitHub.
    if (!isOurReleasePage(url)) {
      log.error({ url }, "Not opening a page that isn't Streamy's releases");
      return { status: "error", message: UPDATE_MESSAGES.browser };
    }
    try {
      await this.#options.openExternal(url);
      return { status: "ok" };
    } catch (error) {
      log.warn({ err: error }, "Could not open the release page");
      return { status: "error", message: UPDATE_MESSAGES.browser };
    }
  }

  /** Stops the timers (when Streamy quits). */
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#checkTimer);
    clearTimeout(this.#installTimer);
    this.#listeners.clear();
  }

  #scheduleCheck(delayMs: number): void {
    if (
      this.#options.mode === "unsupported" ||
      this.#disposed ||
      this.#installing
    ) {
      return;
    }
    this.#checkTimer = setTimeout(() => {
      this.#checkTimer = undefined;
      const next = () => {
        // Turned off meanwhile, or turned off and on (which scheduled one).
        if (this.#automatic && !this.#checkTimer) {
          this.#scheduleCheck(CHECK_INTERVAL_MS);
        }
      };
      void this.check().then(next, next);
    }, delayMs);
  }

  async #runCheck(): Promise<UpdateStatus> {
    const { log } = this.#options;
    const previous = this.#status;
    // A version we already know about stays on screen while we look again.
    const quiet = previous.state === "available";
    if (!quiet) this.#setStatus({ state: "checking" });
    try {
      if (this.#options.mode === "auto") await this.#checkAuto();
      else await this.#checkNotify();
    } catch (error) {
      const kind = classifyFailure(error);
      if (kind === "no-release") {
        // Expected until the first release: no stack trace needed.
        const reason = error instanceof Error ? error.message : String(error);
        log.info(
          { reason: reason.split("\n")[0] },
          "No release to update to yet",
        );
        this.#upToDate();
      } else {
        log.warn({ err: error }, "Could not check for updates");
        this.#setStatus(
          quiet
            ? previous
            : { state: "error", message: messageFor(kind, "check") },
        );
      }
    }
    return this.status();
  }

  async #checkAuto(): Promise<void> {
    const { log } = this.#options;
    const result = await this.#getBackend().checkForUpdates();
    if (!result?.isUpdateAvailable) {
      log.info(
        { latest: result?.updateInfo.version ?? null },
        "Streamy is up to date",
      );
      this.#upToDate();
      return;
    }
    const { version } = result.updateInfo;
    this.#releaseTag = `v${version}`;
    const download = result.downloadPromise;
    if (!download) throw new Error("electron-updater didn't start a download");

    log.info({ version }, "Downloading an update");
    this.#setStatus({ state: "downloading", version, percent: 0 });
    download.then(
      () => {
        if (this.#disposed) return;
        log.info({ version }, "Update downloaded; it installs on restart");
        this.#setStatus({ state: "ready", version });
      },
      (error: unknown) => {
        if (this.#disposed) return;
        log.warn({ err: error, version }, "Could not download the update");
        this.#setStatus({
          state: "error",
          message: messageFor(classifyFailure(error), "download"),
        });
      },
    );
  }

  async #checkNotify(): Promise<void> {
    const { log, currentVersion } = this.#options;
    const latest = await fetchLatestRelease(
      this.#options.fetch,
      currentVersion,
    );
    if (!latest) {
      log.info("No release to update to yet");
      this.#upToDate();
      return;
    }
    this.#releaseTag = latest.tag;
    const newer = (compareVersions(latest.version, currentVersion) ?? 0) > 0;
    if (!newer) {
      log.info({ latest: latest.version }, "Streamy is up to date");
      this.#upToDate();
      return;
    }
    log.info({ version: latest.version }, "A new version is available");
    this.#setStatus({
      state: "available",
      version: latest.version,
      canInstall: false,
    });
  }

  #getBackend(): UpdateBackend {
    if (!this.#backend) {
      const backend = this.#options.createBackend();
      backend.on("download-progress", (progress) => {
        this.#onProgress(progress.percent);
      });
      this.#backend = backend;
    }
    return this.#backend;
  }

  #onProgress(percent: number): void {
    const status = this.#status;
    if (status.state !== "downloading" || !Number.isFinite(percent)) return;
    // Whole percents: one message per step, not one per network packet.
    const next = Math.min(100, Math.max(0, Math.floor(percent)));
    if (next !== status.percent) this.#setStatus({ ...status, percent: next });
  }

  #upToDate(): void {
    const now = this.#options.now?.() ?? Date.now();
    this.#setStatus({ state: "idle", checkedAt: new Date(now).toISOString() });
  }

  #setStatus(status: UpdateStatus): void {
    if (this.#disposed) return;
    if (JSON.stringify(status) === JSON.stringify(this.#status)) return;
    this.#status = status;
    for (const listener of this.#listeners) listener(this.status());
  }
}

// electron-updater's errors carry a `code` ("ERR_UPDATER_…", "HTTP_ERROR_404")
// and sometimes wrap another error's stack in their message.
const NO_RELEASE_CODES = new Set([
  // The releases feed is empty.
  "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
  // The newest release has no latest.yml (e.g. it was published by hand).
  "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
]);
const OFFLINE =
  /net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|ADDRESS_UNREACHABLE|CONNECTION_\w+|TIMED_OUT|PROXY_\w+|TUNNEL_CONNECTION_FAILED)|\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/;
const BUSY = /HttpError: (?:403|429|5\d\d)\b|rate limit/i;

/** Sorts an update error into the few cases people are told about. */
export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof GitHubCheckError) {
    return error.kind === "unexpected" ? "other" : error.kind;
  }
  const fields =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; statusCode?: unknown })
      : {};
  const text =
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);

  if (typeof fields.code === "string" && NO_RELEASE_CODES.has(fields.code)) {
    return "no-release";
  }
  if (text.includes("No published versions on GitHub")) return "no-release";
  // github.com/…/releases/latest answers 404 while there's no release.
  if (
    fields.code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" &&
    /HttpError: 404\b/.test(text)
  ) {
    return "no-release";
  }
  const status = typeof fields.statusCode === "number" ? fields.statusCode : 0;
  if (status === 403 || status === 429 || status >= 500 || BUSY.test(text)) {
    return "busy";
  }
  if (OFFLINE.test(text)) return "offline";
  return "other";
}

function messageFor(kind: FailureKind, during: "check" | "download"): string {
  if (kind === "offline") return UPDATE_MESSAGES.offline;
  if (kind === "busy") return UPDATE_MESSAGES.busy;
  return UPDATE_MESSAGES[during];
}

/** Waits for `promise`, but no longer than `ms`. */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
