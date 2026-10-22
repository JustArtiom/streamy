import type { CacheInfo } from "../../../../shared/engine-api";
import { getCacheInfo } from "../../../cache";
import { getRuntime } from "../../../config";
import { appRoute } from "../../../http/app-route";
import { engineServices } from "../../../services";

/** GET /v1/cache → CacheInfo (Settings → Storage, through main). */
export const handler = appRoute(async (_ctx, _req, res) => {
  const { cacheDir, cacheLimitBytes } = getRuntime().config;
  const info = await getCacheInfo(cacheDir, cacheLimitBytes);
  const body: CacheInfo = {
    ...info,
    // Paused downloads stay paused up to 1.5 GB free (cache/disk-guard.ts).
    lowDiskSpace:
      info.lowDiskSpace || (engineServices()?.diskGuard.isLow() ?? false),
  };
  res.json(body);
});
