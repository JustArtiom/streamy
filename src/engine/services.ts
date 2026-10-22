import type { CachePolicy, DiskGuard } from "./cache";
import type { LibraryStore } from "./library";
import type { ThumbnailMaker } from "./media/thumbnails";
import type { TorrentLifecycle } from "./torrents/lifecycle";

/*
 * The engine's long-running parts that routes need, set by startEngine()
 * and cleared at shutdown. null outside a running engine (e.g. tests of a
 * single router): routes then do without (no library lookups, no disk
 * guard), or answer 503 when they can't.
 */

export type EngineServices = {
  library: LibraryStore;
  lifecycle: TorrentLifecycle;
  cachePolicy: CachePolicy;
  diskGuard: DiskGuard;
  thumbnails: ThumbnailMaker;
};

let current: EngineServices | null = null;

export function setEngineServices(services: EngineServices | null): void {
  current = services;
}

export function engineServices(): EngineServices | null {
  return current;
}
