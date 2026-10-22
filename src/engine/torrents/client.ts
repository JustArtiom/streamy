import WebTorrent, { type ClientOptions } from "webtorrent";
import type { EngineConfig } from "../../shared/engine-protocol";
import { getRuntime, toWebTorrentRate } from "../config";
import { logger } from "../lib/logger";

/*
 * The one WebTorrent client of the engine. It's created on the first add,
 * not at start: launching Streamy must not announce anything to anyone
 * (no DHT, no ports opened) until the user opens a torrent.
 */

const log = logger.child({ module: "torrent-client" });

let client: WebTorrent | null = null;
let destroying: Promise<void> | null = null;
/** Tests: e.g. no DHT/trackers/LSD, to only talk to a local seeder. */
let extraOptions: ClientOptions = {};
/** The disk is almost full: nothing comes in from peers (see pauseDownloads). */
let downloadsPaused = false;

/** WebTorrent's download rate: 0 while paused, else the user's limit. */
function downloadRate(config: EngineConfig): number {
  return downloadsPaused ? 0 : toWebTorrentRate(config.downloadLimit);
}

function clientOptions(config: EngineConfig): ClientOptions {
  return {
    downloadLimit: downloadRate(config),
    uploadLimit: toWebTorrentRate(config.uploadLimit),
    maxConns: config.maxConnections,
    // uTP stays off in v1 (PLAN §4.4): WebTorrent 3.0.21 tries every IPv4
    // peer over uTP 4 times before TCP, so a TCP-only peer takes ~40 s to
    // reach. WebRTC (browser peers) stays at WebTorrent's default: on.
    utp: false,
    ...extraOptions,
  };
}

/** The client, created on first use. */
export function getTorrentClient(): WebTorrent {
  if (destroying) throw new Error("The torrent client is shutting down");

  // WebTorrent destroys the whole client on a fatal error (e.g. the DHT
  // can't start). Start a fresh one instead of failing every add from then on.
  if (client?.destroyed) {
    log.warn("Torrent client was destroyed, starting a new one");
    client = null;
  }

  if (!client) {
    client = new WebTorrent(clientOptions(getRuntime().config));
    // Torrent errors without their own listener land here too. Log them;
    // never let them crash the engine.
    client.on("error", (err: unknown) => {
      log.error({ err }, "Torrent client error");
    });
  }
  return client;
}

/** The client if it was started, without starting it. */
export function peekTorrentClient(): WebTorrent | null {
  return client && !client.destroyed ? client : null;
}

/**
 * Settings changed: speed limits and the connection cap apply right away
 * (WebTorrent reads maxConns whenever a torrent looks for peers, so running
 * torrents follow too). A client that doesn't exist yet gets them when made.
 */
export function applyClientConfig(config: EngineConfig): void {
  const current = peekTorrentClient();
  if (!current) return;
  current.throttleDownload(downloadRate(config));
  current.throttleUpload(toWebTorrentRate(config.uploadLimit));
  current.maxConns = config.maxConnections;
}

/**
 * The disk is almost full: stop taking data from peers, or start again.
 *
 * A download limit of 0 holds every byte peers and web seeds send in
 * WebTorrent's throttle (speed-limiter treats rate 0 as "stop", and checks
 * again every second), so no new piece reaches the disk. Reading what's
 * already on disk doesn't go through peers, so that keeps playing. The
 * user's own limit comes back on resume, and settings changes meanwhile
 * keep the 0.
 *
 * Held back means everything, handshakes and answers included: the
 * torrents keep their connections alive meanwhile and reconnect on resume
 * (pauseDownloads in torrents/service.ts). Why not something else
 * (WebTorrent 3.0.21): torrent.pause() only stops new connections;
 * deselecting stops background downloads but every read (the player)
 * still asks peers for its pieces.
 */
export function setDownloadsPaused(paused: boolean): void {
  if (downloadsPaused === paused) return;
  downloadsPaused = paused;
  peekTorrentClient()?.throttleDownload(downloadRate(getRuntime().config));
}

export function areDownloadsPaused(): boolean {
  return downloadsPaused;
}

/**
 * Stops every torrent and closes all connections, for good (the engine is
 * shutting down: no new client after this). The downloaded data stays on
 * disk (it's the cache). Safe to call twice.
 */
export function destroyTorrentClient(): Promise<void> {
  const current = client;
  if (!current || current.destroyed) {
    destroying ??= Promise.resolve();
    return destroying;
  }

  destroying ??= new Promise<void>((resolve) => {
    current.destroy((err) => {
      if (err) log.warn({ err }, "Torrent client didn't close cleanly");
      resolve();
    });
  });
  return destroying;
}

/** Tests: extra client options for the next client made. */
export function setTorrentClientOptionsForTests(options: ClientOptions): void {
  extraOptions = options;
}

/** Tests: allow a new client after destroyTorrentClient(). */
export function resetTorrentClientForTests(): void {
  client = null;
  destroying = null;
  extraOptions = {};
  downloadsPaused = false;
}
