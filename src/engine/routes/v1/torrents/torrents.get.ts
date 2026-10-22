import { appRoute } from "../../../http/app-route";
import { torrentService } from "../../../torrents/service";

/** GET /v1/torrents: most recent activity first. */
export const handler = appRoute((_ctx, _req, res) => {
  res.json({ torrents: torrentService.list() });
});
