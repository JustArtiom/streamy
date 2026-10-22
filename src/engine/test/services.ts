import { join } from "node:path";
import { createCachePolicy, createDiskGuard } from "../cache";
import { getRuntime } from "../config";
import {
  connectLibrary,
  type LibraryStore,
  openInMemoryLibrary,
} from "../library";
import { playbackService } from "../media/playback";
import type { ThumbnailMaker } from "../media/thumbnails";
import { type EngineServices, setEngineServices } from "../services";
import { createTorrentLifecycle } from "../torrents/lifecycle";
import {
  deleteStoredTorrent,
  pauseDownloads,
  stopBackgroundDownload,
  torrentService,
  torrentUsage,
} from "../torrents/service";

/*
 * Test helper: the engine's services as startEngine wires them, minus the
 * timers and ffmpeg: an in-memory library, a disk whose free space the test
 * sets, and a thumbnail maker that only records what it was asked. (The
 * policy doesn't run when the disk gets low: tests run it themselves.)
 */

const GB = 1024 ** 3;

export type TestServices = EngineServices & {
  /** What the thumbnail maker was asked to consider / forget. */
  considered: { infoHash: string; fileIndex: number; position: number }[];
  forgotten: { infoHash: string; fileIndex: number | undefined }[];
  /** Sets the free space and lets the guard look at it. */
  setFreeSpace(bytes: number | null): Promise<void>;
  teardown(): Promise<void>;
};

/** Needs useTestRuntime() first. */
export function useTestServices(): TestServices {
  let free: number | null = 100 * GB;
  const considered: TestServices["considered"] = [];
  const forgotten: TestServices["forgotten"] = [];

  const library: LibraryStore = openInMemoryLibrary({
    logger: { info: () => undefined, warn: () => undefined },
    thumbnailsDir: join(getRuntime().dataDir, "thumbnails"),
  });
  const diskGuard = createDiskGuard({
    cacheDir: () => getRuntime().config.cacheDir,
    isDownloading: () => false,
    setPaused: pauseDownloads,
    freeSpace: () => Promise.resolve(free),
  });
  const cachePolicy = createCachePolicy({
    config: () => getRuntime().config,
    activeTorrents: () => torrentUsage(),
    deleteStored: deleteStoredTorrent,
    stopBackgroundDownload,
    isDiskLow: () => diskGuard.isLow(),
    freeSpace: () => Promise.resolve(free),
  });
  const lifecycle = createTorrentLifecycle({
    usage: torrentUsage,
    stop: (infoHash) => torrentService.stop(infoHash),
    isPlaying: (infoHash) => playbackService.isPlaying(infoHash),
    keepSharingMinutes: () => getRuntime().config.keepSharingMinutes,
  });
  const thumbnails: ThumbnailMaker = {
    consider: ({ infoHash, fileIndex, position }) =>
      considered.push({ infoHash, fileIndex, position }),
    forget: (infoHash, fileIndex) => forgotten.push({ infoHash, fileIndex }),
    idle: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  const disconnect = connectLibrary(library, thumbnails, {
    onMetadata: (listener) => torrentService.onMetadata(listener),
    onRemoved: (listener) => torrentService.onRemoved(listener),
    onHeartbeat: (listener) => playbackService.onHeartbeat(listener),
  });
  const services = { library, diskGuard, cachePolicy, lifecycle, thumbnails };
  setEngineServices(services);

  return {
    ...services,
    considered,
    forgotten,
    async setFreeSpace(bytes) {
      free = bytes;
      await diskGuard.check();
    },
    async teardown() {
      free = 100 * GB;
      await diskGuard.check();
      disconnect();
      setEngineServices(null);
      library.close();
    },
  };
}
