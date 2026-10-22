import { logger } from "../lib/logger";
import type { TorrentUsage } from "./service";

/*
 * When active torrents stop (PLAN §4.4). Stopping keeps the data (it's the
 * cache) and saves the torrent's resume record; opening it again later is
 * instant.
 *
 * A torrent is "in use" while something keeps touching it: its page polling
 * GET /v1/torrents/:infoHash, the player or ffmpeg reading its files (a read
 * in progress counts the whole time), or a playback session being alive
 * (heartbeats). Its last use is TorrentSummary.lastActivityAt.
 *
 * - Idle: unused for the "Keep sharing after watching" setting, it stops.
 * - Too many: adding a 6th stops the least recently used one.
 * - A torrent with a live playback session is never stopped.
 */

const log = logger.child({ module: "torrent-lifecycle" });

/** At most this many torrents are active (the prototype's MAX_ACTIVE_TORRENTS). */
export const MAX_ACTIVE_TORRENTS = 5;
/** How often idle torrents are looked for. */
export const IDLE_CHECK_MS = 30_000;
/**
 * Even "stop right away" (0 minutes) waits this long after the last use, so
 * a page reload or a moment between two videos doesn't stop it.
 */
export const MIN_IDLE_MS = 45_000;

export type LifecycleDeps = {
  /** The active torrents, with how long each has been idle. */
  usage(now: number): TorrentUsage[];
  /** Stops one, keeping its data. */
  stop(infoHash: string): Promise<void>;
  /** A playback session is alive for it. */
  isPlaying(infoHash: string): boolean;
  /** The setting, read at every check: minutes, 0 = soon, null = until quit. */
  keepSharingMinutes(): number | null;
  /** After a torrent was stopped here (e.g. the cache policy checks the limit). */
  onStopped?(infoHash: string): void;
  now?: () => number;
  maxActive?: number;
};

export type TorrentLifecycle = {
  /** Starts the idle check timer. */
  start(): void;
  /** Stops idle torrents now (also what the timer does). One at a time. */
  checkIdle(): Promise<void>;
  /**
   * A torrent was just added: if that's one too many, stops the least
   * recently used other one that isn't playing (failed ones first).
   */
  makeRoom(added: string): Promise<void>;
  /** Stops the timer. */
  stop(): void;
};

/** How long a torrent may stay unused, in ms (Infinity = until quit). */
export function idleLimitMs(keepSharingMinutes: number | null): number {
  if (keepSharingMinutes === null) return Infinity;
  return Math.max(keepSharingMinutes * 60_000, MIN_IDLE_MS);
}

export function createTorrentLifecycle(deps: LifecycleDeps): TorrentLifecycle {
  const now = deps.now ?? Date.now;
  const maxActive = deps.maxActive ?? MAX_ACTIVE_TORRENTS;
  let timer: NodeJS.Timeout | null = null;
  let checking: Promise<void> | null = null;

  async function stopQuietly(infoHash: string): Promise<void> {
    try {
      await deps.stop(infoHash);
      deps.onStopped?.(infoHash);
    } catch (err) {
      log.warn({ err, infoHash }, "Couldn't stop a torrent");
    }
  }

  /** That torrent's usage right now, or undefined once it's not active. */
  function usageOf(infoHash: string): TorrentUsage | undefined {
    return deps.usage(now()).find((t) => t.infoHash === infoHash);
  }

  async function stopIdle(): Promise<void> {
    const limit = idleLimitMs(deps.keepSharingMinutes());
    if (limit === Infinity) return;
    const idle = deps
      .usage(now())
      .filter((t) => t.idleMs >= limit && !deps.isPlaying(t.infoHash));
    for (const { infoHash } of idle) {
      // Looked at again right before: the stops before this one took a
      // while, and it may be playing (or used) by now.
      const current = usageOf(infoHash);
      if (!current || current.idleMs < limit || deps.isPlaying(infoHash)) {
        continue;
      }
      log.info(
        { infoHash, idleMinutes: Math.round(current.idleMs / 60_000) },
        "Stopping a torrent nobody uses (its data stays)",
      );
      await stopQuietly(infoHash);
    }
  }

  function checkIdle(): Promise<void> {
    checking ??= stopIdle().finally(() => {
      checking = null;
    });
    return checking;
  }

  /**
   * The least recently used active torrent that may stop to make room
   * (failed ones first), never `added` or one that's playing.
   */
  function nextVictim(added: string): TorrentUsage | undefined {
    return deps
      .usage(now())
      .filter((t) => t.infoHash !== added && !deps.isPlaying(t.infoHash))
      .sort(
        (a, b) =>
          Number(b.failed) - Number(a.failed) ||
          a.lastActivityAt - b.lastActivityAt,
      )[0];
  }

  async function makeRoom(added: string): Promise<void> {
    // One at a time, looking again before each stop: a stop takes a while,
    // and meanwhile something may start playing, or stop on its own.
    while (deps.usage(now()).length > maxActive) {
      const victim = nextVictim(added);
      if (!victim) {
        // Better one torrent too many than stopping what someone watches.
        log.warn(
          { active: deps.usage(now()).length, limit: maxActive },
          "Every other torrent is playing: going over the limit for now",
        );
        return;
      }
      log.info(
        { infoHash: victim.infoHash, limit: maxActive },
        "Too many torrents: stopping the least recently used one",
      );
      await stopQuietly(victim.infoHash);
      // Still there (the stop failed): don't try it again and again.
      if (usageOf(victim.infoHash)) return;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void checkIdle();
      }, IDLE_CHECK_MS);
      timer.unref();
    },
    checkIdle,
    makeRoom,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
