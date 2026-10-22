import { CacheDirError } from "../../../cache";
import { appRoute } from "../../../http/app-route";
import { AppError, ErrorCode } from "../../../http/errors";
import { playbackService } from "../../../media/playback";
import { engineServices } from "../../../services";
import { settleAllTorrents, torrentService } from "../../../torrents/service";

/**
 * POST /v1/cache/clear → 204. Stops every playback and torrent, then
 * deletes the downloaded videos. The library (history, positions) stays.
 * Never at the same time as a cache policy run.
 */
export const handler = appRoute(async (_ctx, _req, res) => {
  const services = engineServices();
  if (!services) {
    throw new AppError(
      ErrorCode.ServiceUnavailable,
      "The playback engine is starting or stopping. Try again in a moment.",
    );
  }
  try {
    await services.cachePolicy.clear(async () => {
      await playbackService.stopAll();
      // No records: their data is about to go.
      await Promise.all(
        torrentService
          .list()
          .map(({ infoHash }) =>
            torrentService.stop(infoHash, { saveRecord: false }),
          ),
      );
      // A stop that was already going (an idle one) could otherwise save
      // its record after the folder is emptied.
      await settleAllTorrents();
    });
  } catch (err) {
    if (err instanceof CacheDirError) {
      throw new AppError(ErrorCode.Conflict, err.message);
    }
    throw err;
  }
  res.status(204).end();
});
