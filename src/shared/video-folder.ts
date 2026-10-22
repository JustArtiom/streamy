// The video folder ("cache"): names main and the engine must agree on. Main
// makes and marks the folder (src/main/settings/cache-dir.ts); the engine is
// the only one that writes inside it (src/engine/cache/).
//
// Constants only: no runtime dependencies.

/** A file in the folder saying "this folder is Streamy's". */
export const CACHE_MARKER = ".streamy-cache";

/** The only folders Streamy writes into. Clearing the cache empties these. */
export const CACHE_CONTENT_DIRS = [
  "torrents",
  "playback",
  "subtitles",
] as const;

export type CacheContentDir = (typeof CACHE_CONTENT_DIRS)[number];
