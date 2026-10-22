import { logger } from "../lib/logger";
import type { PlaybackHeartbeatEvent } from "../media/playback";
import type { ThumbnailMaker } from "../media/thumbnails";
import type { TorrentMetadataEvent, TorrentRemoval } from "../torrents/service";
import type { LibraryStore } from "./types";

/*
 * The library, connected to the running engine:
 * - a torrent's metadata arrives → it's recorded (name, magnet, .torrent),
 *   so it can be re-opened later without peers;
 * - a playback heartbeat → the position is saved (Continue watching), and
 *   the file's thumbnail made or refreshed in the background;
 * - a torrent removed with "forget" → its history goes too.
 *
 * The library must never get in the way of watching: every failure here is
 * logged and swallowed.
 */

const log = logger.child({ module: "library" });

/** What the hooks listen to (torrentService and playbackService). */
export type LibrarySources = {
  onMetadata(listener: (event: TorrentMetadataEvent) => void): () => void;
  onRemoved(
    listener: (infoHash: string, removal: TorrentRemoval) => void,
  ): () => void;
  onHeartbeat(listener: (event: PlaybackHeartbeatEvent) => void): () => void;
};

/** Starts listening. Returns a function that stops it. */
export function connectLibrary(
  library: LibraryStore,
  thumbnails: ThumbnailMaker,
  sources: LibrarySources,
): () => void {
  /** A failing save is logged once, not every 5 s while the player is open. */
  let saveFailing = false;

  function record(event: TorrentMetadataEvent): void {
    try {
      library.recordTorrent({
        infoHash: event.infoHash,
        name: event.name,
        magnet: event.magnet,
        metadata: event.torrentFile,
        totalSize: event.size,
      });
    } catch (err) {
      log.warn({ err, infoHash: event.infoHash }, "Couldn't record a torrent");
    }
  }

  function save(event: PlaybackHeartbeatEvent): void {
    try {
      const saved = library.saveProgress({
        infoHash: event.infoHash,
        fileIndex: event.fileIndex,
        fileName: event.fileName,
        position: event.position,
        duration: event.duration,
        audioTrack: event.audioTrack,
        // undefined = the player didn't say: keep what's saved.
        subtitle: event.subtitle,
      });
      saveFailing = false;
      thumbnails.consider(saved);
    } catch (err) {
      if (!saveFailing) {
        log.warn(
          { err, infoHash: event.infoHash, fileIndex: event.fileIndex },
          "Couldn't save the position",
        );
      }
      saveFailing = true;
    }
  }

  function forget(infoHash: string, removal: TorrentRemoval): void {
    if (!removal.forget) return;
    thumbnails.forget(infoHash);
    try {
      library.forgetTorrent(infoHash);
    } catch (err) {
      log.warn({ err, infoHash }, "Couldn't forget a torrent");
    }
  }

  const stops = [
    sources.onMetadata(record),
    sources.onHeartbeat(save),
    sources.onRemoved(forget),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
