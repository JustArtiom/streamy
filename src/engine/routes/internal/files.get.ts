import { z } from "zod";
import { appRoute } from "../../http/app-route";
import { AppError, ErrorCode } from "../../http/errors";
import { openFileToken } from "../../torrents/file-tokens";
import { sendTorrentFile } from "../../torrents/send-file";
import { torrentService } from "../../torrents/service";

const schema = z.object({
  params: z.object({ token: z.string().min(1).max(128) }),
});

/**
 * GET/HEAD /internal/files/:token: a torrent file's bytes for ffmpeg and
 * ffprobe (Range, urgent pieces: like /v1/…/stream). No secret: the token
 * is the permission, and it only opens the one file it was made for.
 * A playback's token can hold its bytes back while that playback is far
 * ahead of the viewer (other tokens keep flowing).
 */
export const handler = appRoute({ schema }, async ({ params }, req, res) => {
  const opened = openFileToken(params.token);
  // Same answer for "never existed" and "expired": nothing to learn here.
  if (!opened) throw new AppError(ErrorCode.NotFound, "Not found");

  const { target, gate } = opened;
  torrentService.touch(target.infoHash);
  await sendTorrentFile(
    req,
    res,
    torrentService.getFile(target.infoHash, target.fileIndex),
    { gate },
  );
});
