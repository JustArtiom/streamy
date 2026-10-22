import type { TorrentDetail } from "../../../../shared/engine-api";
import { logger } from "../../../lib/logger";
import { engineServices } from "../../../services";
import {
  type AddTorrentInput,
  torrentService,
} from "../../../torrents/service";
import { admitTorrent } from "../guards";

const log = logger.child({ module: "torrents" });

/**
 * POST /v1/torrents and /v1/torrents/file: opens a torrent.
 *
 * - Already active: just marks it as opened (a magnet's x.pe peers are
 *   added to it). One that failed is started again.
 * - Known to the library: starts from its saved metadata (no waiting for
 *   peers), with fast resume from what's on disk. A bare info hash gets
 *   the saved magnet's trackers and peers.
 * - Refused (503) while the videos are being cleared, and a new torrent
 *   while the disk is almost full (see admitTorrent).
 * - One too many active: the least recently used other one stops.
 */
export async function openTorrent(
  input: AddTorrentInput,
): Promise<{ torrent: TorrentDetail; created: boolean }> {
  const services = engineServices();
  const library = services?.library ?? null;

  const result = await torrentService.add(input, {
    saved: library
      ? (infoHash) => {
          const known = library.getTorrent(infoHash);
          return known && { metadata: known.metadata, magnet: known.magnet };
        }
      : undefined,
    admit: admitTorrent,
  });

  const { infoHash } = result.torrent;
  try {
    // Recent is sorted by this. A new torrent is recorded once its
    // metadata is known (that sets it too).
    library?.touchTorrent(infoHash);
  } catch (err) {
    log.warn({ err, infoHash }, "Couldn't mark the torrent as opened");
  }
  if (result.created && services) {
    services.lifecycle.makeRoom(infoHash).catch((err: unknown) => {
      log.warn({ err }, "Couldn't make room for the new torrent");
    });
  }
  return result;
}
