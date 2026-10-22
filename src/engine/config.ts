import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type {
  EngineConfig,
  EngineConfigMessage,
  EngineInitMessage,
  EngineShutdownMessage,
  LogLevel,
  MainToEngineMessage,
} from "../shared/engine-protocol";
import { PLAYBACK_DIR, SUBTITLES_DIR, TORRENTS_DIR } from "./cache";

/*
 * The engine's settings. Main sends them in the `init` message (and again in
 * a `config` message whenever the user changes something); the rest are
 * fixed defaults (`Tuning`, the prototype's values).
 *
 * Everything reads them through getRuntime() at the moment it needs them,
 * so a change applies to the next torrent / playback without a restart.
 */

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * Public trackers added to every torrent. Magnet links often come with few or
 * dead trackers, and more trackers = peers (and metadata) found much faster.
 */
export const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
];

/** Engine knobs that aren't user settings. */
export type Tuning = {
  /** Added to every non-private torrent. */
  trackers: string[];
  /** Keep downloading the rest of the watched file in the background. */
  backgroundDownload: boolean;
  /** Length of an HLS segment. */
  hlsSegmentSeconds: number;
  /** ffmpeg pauses when it's this far ahead of the viewer (saves CPU/disk). */
  transcodeAheadSeconds: number;
  /** At most this many sessions re-encoding video at the same time. */
  maxTranscodes: number;
  /** A playback session with no heartbeat for this long is stopped. */
  playbackIdleSeconds: number;
  /** How long creating a playback may wait for the first video segment. */
  playbackStartTimeoutSeconds: number;
  /**
   * Let magnets and .torrent files name trackers, web seeds and peers on
   * this computer or the local network (lib/local-address.ts). Off in a
   * normal run; test mode turns it on (its seeder is on 127.0.0.1).
   */
  allowLocalAddresses: boolean;
};

export const DEFAULT_TUNING: Readonly<Tuning> = Object.freeze({
  trackers: DEFAULT_TRACKERS,
  backgroundDownload: true,
  hlsSegmentSeconds: 4,
  transcodeAheadSeconds: 240,
  maxTranscodes: 2,
  playbackIdleSeconds: 60,
  playbackStartTimeoutSeconds: 120,
  allowLocalAddresses: false,
});

/** A .torrent file (upload or main's "open file") may be at most this big. */
export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024;

export { MAX_MAGNET_LENGTH } from "../shared/engine-api";

/** Torrents with more files than this are refused (hostile or useless). */
export const MAX_TORRENT_FILES = 10_000;

// ─── Validation of main's messages ───────────────────────────────────────────

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), "Must be an absolute path");

/** Bytes per second; null (and 0, like the prototype) = unlimited. */
const rateLimit = z.number().nonnegative().nullable();

const engineConfigSchema = z.object({
  cacheDir: absolutePath,
  cacheLimitBytes: z.number().nonnegative().nullable(),
  hardwareEncoding: z.enum(["auto", "off"]),
  downloadLimit: rateLimit,
  uploadLimit: rateLimit,
  keepSharingMinutes: z.number().nonnegative().nullable(),
  maxConnections: z.number().int().positive().max(10_000),
}) satisfies z.ZodType<EngineConfig>;

const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]) satisfies z.ZodType<LogLevel>;

// Unknown extra fields are dropped, not refused: a newer main may send more.
const initSchema = z.object({
  type: z.literal("init"),
  // 32 random bytes as hex. Anything much shorter would be guessable.
  secret: z.string().min(32),
  config: engineConfigSchema,
  dataDir: absolutePath,
  logsDir: absolutePath,
  ffmpegPath: z.string().min(1),
  ffprobePath: z.string().min(1),
  logLevel: logLevelSchema,
  appVersion: z.string().min(1),
}) satisfies z.ZodType<EngineInitMessage>;

const configSchema = z.object({
  type: z.literal("config"),
  config: engineConfigSchema,
}) satisfies z.ZodType<EngineConfigMessage>;

const shutdownSchema = z.object({
  type: z.literal("shutdown"),
}) satisfies z.ZodType<EngineShutdownMessage>;

const messageSchema = z.discriminatedUnion("type", [
  initSchema,
  configSchema,
  shutdownSchema,
]) satisfies z.ZodType<MainToEngineMessage>;

/** Checks a message from main. The error text never contains the secret. */
export function parseMainMessage(
  data: unknown,
): { ok: true; message: MainToEngineMessage } | { ok: false; error: string } {
  const result = messageSchema.safeParse(data);
  if (result.success) return { ok: true, message: result.data };
  // Only paths and messages: never the values (the init carries the secret).
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(message)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error: `Invalid message from main: ${issues}` };
}

// ─── Current state ───────────────────────────────────────────────────────────

/** What the rest of the engine reads. */
export type EngineRuntime = {
  /** Streamy's version (for /v1/health). */
  appVersion: string;
  /** library.db and thumbnails go here. */
  dataDir: string;
  logsDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** The user's settings. Replaced as a whole by a `config` message. */
  config: EngineConfig;
  tuning: Tuning;
};

let runtime: EngineRuntime | null = null;

/** Sets everything up from the init message (once per engine run). */
export function initRuntime(
  init: Omit<EngineInitMessage, "type" | "secret" | "logLevel">,
  tuning: Partial<Tuning> = {},
): EngineRuntime {
  runtime = {
    appVersion: init.appVersion,
    dataDir: init.dataDir,
    logsDir: init.logsDir,
    ffmpegPath: init.ffmpegPath,
    ffprobePath: init.ffprobePath,
    config: { ...init.config },
    tuning: { ...DEFAULT_TUNING, ...tuning },
  };
  return runtime;
}

/** The current settings. Throws if the engine wasn't initialised (a bug). */
export function getRuntime(): EngineRuntime {
  if (!runtime) throw new Error("The engine isn't initialised yet");
  return runtime;
}

/** A `config` message arrived. Returns the settings before the change. */
export function updateConfig(config: EngineConfig): EngineConfig {
  const current = getRuntime();
  const previous = current.config;
  current.config = { ...config };
  return previous;
}

/** Tests: change a default (e.g. a short transcodeAheadSeconds). */
export function updateTuning(patch: Partial<Tuning>): void {
  const current = getRuntime();
  current.tuning = { ...current.tuning, ...patch };
}

/** Tests: forget everything. */
export function resetRuntimeForTests(): void {
  runtime = null;
}

// ─── Folders ─────────────────────────────────────────────────────────────────

/**
 * The engine's folders inside the video folder. It only ever writes here.
 *
 *   torrents/<infoHash>/…           downloaded data (a cache, kept between launches)
 *   playback/<sessionId>/…          HLS playlist, init.mp4, segments, sub_<n>.vtt
 *   subtitles/<infoHash>/<i>.json   subtitle files from torrents, converted to cues
 *
 * playback/ and subtitles/ are emptied at every start; torrents/ is kept.
 */
export type CachePaths = {
  torrents: string;
  playback: string;
  subtitles: string;
};

export function cachePaths(
  cacheDir: string = getRuntime().config.cacheDir,
): CachePaths {
  return {
    torrents: join(cacheDir, TORRENTS_DIR),
    playback: join(cacheDir, PLAYBACK_DIR),
    subtitles: join(cacheDir, SUBTITLES_DIR),
  };
}

/** WebTorrent's rate: bytes per second, -1 = unlimited. */
export function toWebTorrentRate(limit: number | null): number {
  return limit !== null && limit > 0 ? Math.round(limit) : -1;
}
