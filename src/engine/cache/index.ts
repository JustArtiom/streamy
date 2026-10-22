// The video folder ("cache"): layout and safety rules in ./layout.ts. The
// rest of the engine imports from here only.

export { cleanStartup, clearCache, deleteTorrentData } from "./clean";
export {
  createDiskGuard,
  DISK_CHECK_MS,
  type DiskGuard,
  type DiskGuardDeps,
  RESUME_FREE_BYTES,
  shouldPause,
} from "./disk-guard";
export { freeSpace, isLowDisk, LOW_DISK_BYTES } from "./disk-space";
export {
  type EvictionCandidate,
  type EvictionInput,
  type EvictionPlan,
  planEviction,
} from "./eviction";
export { getCacheInfo } from "./info";
export {
  type CachePolicy,
  type CachePolicyDeps,
  createCachePolicy,
  LOW_DISK_TARGET_BYTES,
  POLICY_INTERVAL_MS,
  type PolicyRun,
} from "./policy";
export {
  CACHE_CONTENT_DIRS,
  CACHE_MARKER,
  CacheDirError,
  type CacheDirState,
  cacheDirState,
  isGone,
  PLAYBACK_DIR,
  SUBTITLES_DIR,
  TORRENTS_DIR,
  torrentDataDir,
  torrentRecordFile,
} from "./layout";
export {
  readTorrentRecord,
  type RecordLogger,
  type TorrentRecord,
  writeTorrentRecord,
} from "./record";
export {
  type DiskUsage,
  diskUsage,
  measureCache,
  measureTorrents,
  type TorrentUsage,
} from "./usage";
