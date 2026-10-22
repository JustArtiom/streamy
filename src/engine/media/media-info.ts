import { logger } from "../lib/logger";
import { type TorrentFileHandle, torrentService } from "../torrents/service";
import { ffprobe, type ProbedMedia, toProbedMedia } from "./probe";
import { subtitleFilesFor, toSubtitleTrack } from "./subtitle-files";

/*
 * Media info (ffprobe) per torrent file. ffprobe runs once per file: the
 * promise is cached, so concurrent callers share one run, and dropped on
 * failure so a retry (e.g. after a timeout on a slow torrent) can work.
 */

const log = logger.child({ module: "media-info" });

const cache = new Map<string, Promise<ProbedMedia>>();

let unsubscribeRemovals: (() => void) | null = null;

/** Forget a removed torrent's info (it may come back, re-added, later). */
function forgetTorrent(infoHash: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${infoHash}:`)) cache.delete(key);
  }
}

function hookRemovals() {
  if (unsubscribeRemovals) return;
  try {
    unsubscribeRemovals = torrentService.onRemoved(forgetTorrent);
  } catch (error) {
    log.warn({ err: error }, "Couldn't listen for removed torrents");
  }
}

async function probe(file: TorrentFileHandle): Promise<ProbedMedia> {
  const started = Date.now();
  // ffprobe reads the file over loopback, with a token only it gets.
  const input = file.mintInternalUrl();
  let probed: ProbedMedia;
  try {
    probed = toProbedMedia(await ffprobe(input.url));
  } finally {
    input.revoke();
  }
  log.info(
    {
      infoHash: file.infoHash,
      fileIndex: file.index,
      ms: Date.now() - started,
    },
    "Media info read",
  );

  // Subtitle files shipped with the video become tracks too.
  const torrent = torrentService.get(file.infoHash);
  const video = torrent.files.find((f) => f.index === file.index);
  const fileTracks = video
    ? subtitleFilesFor(video, torrent.files).map((f) =>
        toSubtitleTrack(video, f),
      )
    : [];

  return {
    ...probed,
    info: {
      ...probed.info,
      subtitleTracks: [...probed.info.subtitleTracks, ...fileTracks],
    },
  };
}

export const mediaInfoService = {
  /**
   * The file's media info. Throws NOT_FOUND / CONFLICT (from the torrent
   * side), 400 "This file has no video", 503 (timeout, no ffmpeg).
   */
  get(infoHash: string, fileIndex: number): Promise<ProbedMedia> {
    const file = torrentService.getFile(infoHash, fileIndex);
    torrentService.touch(infoHash);
    hookRemovals();

    const key = `${infoHash}:${fileIndex}`;
    let promise = cache.get(key);
    if (!promise) {
      promise = probe(file);
      cache.set(key, promise);
      promise.catch(() => {
        if (cache.get(key) === promise) cache.delete(key);
      });
    }
    return promise;
  },

  forgetTorrent,

  /** Shutdown and tests: forget everything, stop listening. */
  reset() {
    cache.clear();
    unsubscribeRemovals?.();
    unsubscribeRemovals = null;
  },
};
