import { z } from "zod";
import { appRoute } from "../../../http/app-route";
import { sendTorrentFile } from "../../../torrents/send-file";
import { torrentService } from "../../../torrents/service";
import { fileIndexSchema, infoHashSchema } from "../params";

const schema = z.object({
  params: z.object({ infoHash: infoHashSchema, fileIndex: fileIndexSchema }),
});

/**
 * GET/HEAD /v1/torrents/:infoHash/files/:fileIndex/stream
 * The raw file with Range support, for <video> (direct play). Reading a
 * range makes its pieces urgent.
 */
export const handler = appRoute({ schema }, async ({ params }, req, res) => {
  const { infoHash, fileIndex } = params;
  torrentService.touch(infoHash);
  await sendTorrentFile(req, res, torrentService.getFile(infoHash, fileIndex));
});
