import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  EngineConfig,
  EngineInitMessage,
  EngineToMainMessage,
} from "../shared/engine-protocol";
import {
  cacheDirState,
  cleanStartup,
  createCachePolicy,
  createDiskGuard,
} from "./cache";
import {
  getRuntime,
  initRuntime,
  parseMainMessage,
  type Tuning,
  updateConfig,
} from "./config";
import { createApp } from "./http/app";
import { closeLogFile, flushLog, logger, openLogFile } from "./lib/logger";
import { registerSecret } from "../shared/redact";
import { ensureVideoFolder } from "./lib/video-folder";
import {
  connectLibrary,
  type LibraryStore,
  openEngineLibrary,
} from "./library";
import {
  killAllChildren,
  setAcceptingChildren,
  setChildReporter,
} from "./media/children";
import { getVideoEncoder } from "./media/encoders";
import { checkFfmpeg } from "./media/ffmpeg-check";
import { mediaInfoService } from "./media/media-info";
import { playbackService } from "./media/playback";
import { subtitlesService } from "./media/subtitles";
import { createThumbnailMaker } from "./media/thumbnails";
import { markEngineStarted } from "./routes/v1/health.get";
import { type EngineServices, setEngineServices } from "./services";
import {
  applyClientConfig,
  destroyTorrentClient,
  setDownloadsPaused,
} from "./torrents/client";
import { revokeAllFileTokens, setInternalOrigin } from "./torrents/file-tokens";
import { createTorrentLifecycle } from "./torrents/lifecycle";
import {
  deleteStoredTorrent,
  hasUnfinishedTorrents,
  pauseDownloads,
  releaseAllTorrents,
  saveTorrentRecords,
  stopBackgroundDownload,
  torrentService,
  torrentUsage,
} from "./torrents/service";

/*
 * Starting and stopping the engine. startEngine() does the work and can run
 * in plain Node (tests); runEngineProcess() connects it to main through
 * Electron's process.parentPort (see index.ts).
 */

const log = logger.child({ module: "engine" });

/** How the engine talks back to main. */
export type EngineTransport = {
  post(message: EngineToMainMessage): void;
};

export type RunningEngine = {
  /** The HTTP server's port on 127.0.0.1. */
  port: number;
  server: Server;
  /** A `config` message: new settings. */
  applyConfig(config: EngineConfig): void;
  /**
   * Stops playback (ffmpeg), torrents (keeping their data) and the HTTP
   * server, within `deadlineMs`. Doesn't exit the process.
   */
  shutdown(options?: { deadlineMs?: number }): Promise<void>;
};

/** Main kills the engine 3 s after `shutdown`: be done well before. */
export const SHUTDOWN_DEADLINE_MS = 2_500;

/** How long the last messages to main get before the process exits. */
const EXIT_FLUSH_MS = 150;

/**
 * Part of the shutdown deadline for saving the torrents' resume records,
 * before the client is destroyed. Late ones still finish (atomically) if
 * there's time; missing ones only cost a slower start next time.
 */
const RECORDS_DEADLINE_MS = 1_000;

/**
 * At start: playback/ and subtitles/ only hold what a running engine made,
 * so anything there now is a leftover (a crash, a kill). Half-written
 * resume records go too.
 * torrents/ is the cache and stays. Then all three exist. Only in a video
 * folder that's there and marked as Streamy's: a missing one (an unplugged
 * drive) is never created (adding a torrent says what's wrong instead).
 */
async function prepareVideoFolder(cacheDir: string): Promise<void> {
  const state = await cacheDirState(cacheDir);
  if (state !== "ok") {
    log.warn({ cacheDir, state }, "The video folder isn't available");
    return;
  }
  await cleanStartup(cacheDir);
  await ensureVideoFolder(cacheDir);
}

/**
 * The parts that run in the background: the torrent lifecycle (idle stop,
 * max active), the cache policy (size limit), the free-space guard, and
 * thumbnails; plus the library listening to torrents and playback.
 */
function startServices(library: LibraryStore): {
  services: EngineServices;
  disconnectLibrary: () => void;
} {
  const diskGuard = createDiskGuard({
    cacheDir: () => getRuntime().config.cacheDir,
    isDownloading: hasUnfinishedTorrents,
    setPaused: (paused) => {
      pauseDownloads(paused);
      // Old stored videos make room (cache/policy.ts).
      if (paused) void cachePolicy.run();
    },
  });
  const cachePolicy = createCachePolicy({
    config: () => getRuntime().config,
    activeTorrents: () => torrentUsage(),
    deleteStored: deleteStoredTorrent,
    stopBackgroundDownload,
    isDiskLow: () => diskGuard.isLow(),
    // The free space is measured with every run.
    afterRun: () => diskGuard.check(),
  });
  const lifecycle = createTorrentLifecycle({
    usage: torrentUsage,
    stop: (infoHash) => torrentService.stop(infoHash),
    isPlaying: (infoHash) => playbackService.isPlaying(infoHash),
    keepSharingMinutes: () => getRuntime().config.keepSharingMinutes,
    // Its data is now "stored": it may be what puts the folder over the limit.
    onStopped: () => void cachePolicy.run(),
  });
  const thumbnails = createThumbnailMaker({
    ffmpegPath: () => getRuntime().ffmpegPath,
    library,
    openInput: (infoHash, fileIndex) =>
      torrentService.getFile(infoHash, fileIndex).mintInternalUrl(),
    canRun: () => !diskGuard.isLow(),
  });
  const disconnectLibrary = connectLibrary(library, thumbnails, {
    onMetadata: (listener) => torrentService.onMetadata(listener),
    onRemoved: (listener) => torrentService.onRemoved(listener),
    onHeartbeat: (listener) => playbackService.onHeartbeat(listener),
  });

  lifecycle.start();
  cachePolicy.start();
  diskGuard.start();
  // Right away too: the limit may have changed while Streamy was closed,
  // and /v1/health should know about the disk from the start.
  void cachePolicy.run();

  return {
    services: { library, lifecycle, cachePolicy, diskGuard, thumbnails },
    disconnectLibrary,
  };
}

function stopServices(services: EngineServices): void {
  services.lifecycle.stop();
  services.cachePolicy.stop();
  services.diskGuard.stop();
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Port 0: the OS picks a free one. 127.0.0.1 only: never the network.
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** true if `work` finished within `ms`, false if the time ran out first. */
async function finishesWithin(work: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startEngine(
  init: EngineInitMessage,
  transport: EngineTransport,
  options: { tuning?: Partial<Tuning> } = {},
): Promise<RunningEngine> {
  registerSecret(init.secret);
  initRuntime(init, options.tuning);
  const logFile = await openLogFile({
    dir: init.logsDir,
    level: init.logLevel,
  });
  log.info(
    {
      version: init.appVersion,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      logFile,
    },
    "Engine starting",
  );

  // Before listening: the first request may want the history. A library
  // that can't be opened becomes an in-memory one (logged).
  const library = openEngineLibrary(init.dataDir);

  // A problem with the video folder mustn't stop the engine: adding a
  // torrent will say what's wrong.
  await prepareVideoFolder(init.config.cacheDir).catch((err: unknown) => {
    log.warn(
      { err, cacheDir: init.config.cacheDir },
      "Couldn't prepare the video folder",
    );
  });

  setAcceptingChildren(true);
  setChildReporter((pid, alive) => {
    transport.post({ type: "child", pid, alive });
  });

  // In the background: /v1/health shows null until they're done.
  void checkFfmpeg();
  getVideoEncoder().catch((err: unknown) => {
    log.warn({ err }, "Couldn't detect the video encoder");
  });

  const { services, disconnectLibrary } = startServices(library);
  setEngineServices(services);

  const server = createServer(createApp({ secret: init.secret }));
  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    stopServices(services);
    disconnectLibrary();
    setEngineServices(null);
    library.close();
    throw err;
  }
  setInternalOrigin(`http://127.0.0.1:${port}`);
  markEngineStarted();
  log.info({ port, persistentLibrary: library.persistent }, "Engine listening");

  let stopping: Promise<void> | null = null;

  return {
    port,
    server,

    applyConfig(config) {
      const previous = updateConfig(config);
      applyClientConfig(config);
      const changed = (Object.keys(config) as (keyof EngineConfig)[]).filter(
        (key) => previous[key] !== config[key],
      );
      log.info({ changed }, "Settings changed");

      if (changed.includes("cacheDir")) {
        // New torrents and sessions go there; running ones keep their
        // folder until they stop. The policy only looks at the new one.
        // (Not cleaned here: a session may be starting in it already. Any
        // leftovers go at the next start.)
        ensureVideoFolder(config.cacheDir)
          .catch((err: unknown) => {
            log.warn({ err }, "Couldn't prepare the new video folder");
          })
          .finally(() => void services.cachePolicy.run());
      } else if (changed.includes("cacheLimitBytes")) {
        void services.cachePolicy.run();
      }
      if (changed.includes("keepSharingMinutes")) {
        void services.lifecycle.checkIdle();
      }
    },

    shutdown({ deadlineMs = SHUTDOWN_DEADLINE_MS } = {}) {
      stopping ??= (async () => {
        log.info("Engine shutting down");
        server.close(); // no new connections
        stopServices(services);

        // Gently first: ffmpeg gets SIGTERM, torrents close their files.
        const graceful = Promise.allSettled([
          playbackService.shutdown(),
          services.thumbnails.shutdown(),
          (async () => {
            // Fast resume next time: before the client goes.
            const saved = await finishesWithin(
              saveTorrentRecords(),
              RECORDS_DEADLINE_MS,
            );
            if (!saved) log.warn("Saving the resume records took too long");
            releaseAllTorrents();
            await destroyTorrentClient();
          })(),
        ]);
        const finished = await finishesWithin(graceful, deadlineMs);
        if (!finished) log.warn("Shutdown took too long, cutting it short");

        // Then whatever is left: stragglers (ffprobe, the encoder test) and
        // open connections (video streams never end on their own).
        setAcceptingChildren(false);
        killAllChildren();
        server.closeAllConnections();
        revokeAllFileTokens();
        setInternalOrigin(null);
        mediaInfoService.reset();
        subtitlesService.reset();
        // Nothing can save a position anymore: the library can close.
        disconnectLibrary();
        setEngineServices(null);
        library.close();
        setDownloadsPaused(false);
        setChildReporter(null);
        log.info("Engine stopped");
        closeLogFile();
      })();
      return stopping;
    },
  };
}

// ─── The utility process ─────────────────────────────────────────────────────

/** Electron's process.parentPort, as much of it as the engine uses. */
export type ParentPortLike = {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
};

/**
 * Runs the engine for main: waits for `init`, answers `ready`, follows
 * `config`, and exits after `shutdown` (0) or a fatal error (1). Returns
 * `fatal`, for the process-wide error handlers (index.ts).
 */
export function runEngineProcess(
  port: ParentPortLike,
  deps: {
    start?: typeof startEngine;
    exit?: (code: number) => void;
    /** Where a fatal error is also written (main keeps the engine's stderr). */
    stderr?: (text: string) => void;
  } = {},
): { fatal: (message: string, error?: unknown) => void } {
  const start = deps.start ?? startEngine;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const stderr =
    deps.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const transport: EngineTransport = {
    post: (message) => {
      port.postMessage(message);
    },
  };

  let engine: RunningEngine | null = null;
  let starting: Promise<void> | null = null;
  /** A `config` that came while starting: applied once running. */
  let pendingConfig: EngineConfig | null = null;
  let exiting = false;

  /**
   * Exits a moment later: a message posted right before process.exit() can
   * be lost in a utility process, and main must get `fatal`.
   */
  function exitSoon(code: number): void {
    setTimeout(() => {
      exit(code);
    }, EXIT_FLUSH_MS);
  }

  function fatal(message: string, error?: unknown): void {
    if (exiting) return;
    exiting = true;
    log.fatal({ err: error }, message);
    flushLog();
    // Before the log file is open, stderr is all there is (main keeps it).
    stderr(`Streamy engine: ${message}\n`);
    // Main kills the ones it was told about too; this is belt and braces.
    killAllChildren();
    try {
      transport.post({ type: "fatal", message });
    } catch {
      // Main is gone.
    }
    exitSoon(1);
  }

  async function stopAndExit(): Promise<void> {
    if (exiting) return;
    exiting = true;
    // Never hang: exit even if something in the shutdown is stuck (still
    // before main's own 3 s limit).
    const forced = setTimeout(() => {
      killAllChildren();
      flushLog();
      exit(0);
    }, SHUTDOWN_DEADLINE_MS + 200);
    try {
      await starting;
      await engine?.shutdown();
    } catch (error) {
      log.error({ err: error }, "Shutdown failed");
      flushLog();
    } finally {
      clearTimeout(forced);
      exitSoon(0);
    }
  }

  port.on("message", ({ data }) => {
    const parsed = parseMessage(data);
    if (!parsed) return;

    switch (parsed.type) {
      case "init": {
        if (starting) {
          log.warn("Ignoring a second init message");
          return;
        }
        starting = start(parsed, transport).then(
          (running) => {
            engine = running;
            if (pendingConfig) running.applyConfig(pendingConfig);
            pendingConfig = null;
            if (!exiting) transport.post({ type: "ready", port: running.port });
          },
          (error: unknown) => {
            const reason =
              error instanceof Error ? error.message : String(error);
            fatal(`The engine couldn't start: ${reason}`, error);
          },
        );
        return;
      }
      case "config": {
        if (engine) engine.applyConfig(parsed.config);
        else pendingConfig = parsed.config;
        return;
      }
      case "shutdown": {
        void stopAndExit();
        return;
      }
    }
  });

  function parseMessage(data: unknown) {
    const result = parseMainMessage(data);
    if (result.ok) return result.message;
    // Before init, a bad message means main and engine disagree: fatal.
    if (!starting) fatal(result.error);
    else log.warn({ error: result.error }, "Ignoring a bad message from main");
    return null;
  }

  return { fatal };
}
