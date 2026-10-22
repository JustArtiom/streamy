import type { Health } from "../../../shared/engine-api";
import { getRuntime } from "../../config";
import { appRoute } from "../../http/app-route";
import { currentEncoder } from "../../media/encoders";
import { ffmpegStatus } from "../../media/ffmpeg-check";
import { engineServices } from "../../services";

/** When the engine's HTTP server started (set by the engine at start). */
let startedAt = Date.now();

export function markEngineStarted(now = Date.now()): void {
  startedAt = now;
}

/** GET /v1/health → Health. Cheap: safe to poll every few seconds. */
export const handler = appRoute((_ctx, _req, res) => {
  const health: Health = {
    version: getRuntime().appVersion,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    ffmpeg: ffmpegStatus(),
    encoder: currentEncoder(),
    // Downloading is paused (cache/disk-guard.ts).
    lowDiskSpace: engineServices()?.diskGuard.isLow() ?? false,
  };
  res.json(health);
});
