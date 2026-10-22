// Control messages between the main process and the engine (a utilityProcess).
// They travel over postMessage (main) / process.parentPort (engine). They
// never carry video bytes: those go over the engine's HTTP API.
//
//   main                         engine
//   fork ───────────────────────►
//   init ───────────────────────► opens the log, library, starts HTTP
//        ◄─────────────────────── ready { port }
//   config (settings changed) ──►
//        ◄─────────────────────── child { pid, alive }  (every ffmpeg/ffprobe)
//   shutdown ───────────────────► stops ffmpeg, closes torrents and the library
//        ◄─────────────────────── exits with code 0
//
// Types and constants only: no runtime dependencies.

/** The request header carrying the secret (added by main's proxy). */
export const ENGINE_SECRET_HEADER = "x-streamy-key";

/** How long main waits for `ready` before it gives up on a start. */
export const ENGINE_READY_TIMEOUT_MS = 15_000;

/** How long main waits for the engine to exit after `shutdown`. */
export const ENGINE_SHUTDOWN_TIMEOUT_MS = 3_000;

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/** Settings the engine follows. Sent at start and after every change. */
export interface EngineConfig {
  /** Absolute path of the video folder (already checked and created by main). */
  cacheDir: string;
  /** Most the video folder may hold, in bytes. null = no limit. */
  cacheLimitBytes: number | null;
  /** "off" = always libx264 (CPU), even when a GPU encoder works. */
  hardwareEncoding: "auto" | "off";
  /** Bytes per second. null = unlimited. */
  downloadLimit: number | null;
  uploadLimit: number | null;
  /**
   * How long a torrent stays active (downloading and sharing) after nothing
   * uses it anymore, in minutes. 0 = stop soon after (the engine keeps a
   * short grace period), null = until quit.
   */
  keepSharingMinutes: number | null;
  /** Peer connections per torrent. */
  maxConnections: number;
}

export interface EngineInitMessage {
  type: "init";
  /** 32 random bytes as hex. Every /v1 request must carry it (ENGINE_SECRET_HEADER). */
  secret: string;
  config: EngineConfig;
  /** Folder for library.db and thumbnails (main's userData). */
  dataDir: string;
  /** Folder for engine.log. */
  logsDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  logLevel: LogLevel;
  /** Streamy's version, reported by /v1/health. */
  appVersion: string;
}

export interface EngineConfigMessage {
  type: "config";
  config: EngineConfig;
}

export interface EngineShutdownMessage {
  type: "shutdown";
}

export type MainToEngineMessage =
  EngineInitMessage | EngineConfigMessage | EngineShutdownMessage;

/** The HTTP server is listening on 127.0.0.1:<port>. */
export interface EngineReadyMessage {
  type: "ready";
  port: number;
}

/**
 * An ffmpeg/ffprobe process started (alive: true) or ended (alive: false).
 * If the engine crashes, main kills the ones still alive: on macOS and Linux
 * they would otherwise keep running.
 */
export interface EngineChildMessage {
  type: "child";
  pid: number;
  alive: boolean;
}

/** The engine can't start (e.g. the library can't be opened). It exits next. */
export interface EngineFatalMessage {
  type: "fatal";
  message: string;
}

export type EngineToMainMessage =
  EngineReadyMessage | EngineChildMessage | EngineFatalMessage;
