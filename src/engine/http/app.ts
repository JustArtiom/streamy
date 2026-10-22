import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { redact } from "../../shared/redact";
import { logger, serializeError } from "../lib/logger";
import * as internalFilesGet from "../routes/internal/files.get";
import { v1Router } from "../routes/v1/router";
import { errorHandler, notFoundHandler } from "./error-handler";
import { requireLoopbackHost, requireSecret } from "./security";

/*
 * The engine's HTTP server. Nothing reaches it straight from a browser: the
 * UI's requests come through main's app:// proxy, which adds the secret.
 * So no CORS and no helmet; instead:
 *   - every request must be addressed to 127.0.0.1:<our port> (Host check),
 *   - /v1/* needs the secret,
 *   - /internal/files/<token> needs a valid token (ffmpeg's way in).
 */

// Requests that come every few seconds (or per video segment, or per ffmpeg
// read) while someone watches: logging each would drown everything else.
// Failures still log.
const QUIET_REQUESTS = [
  // Polling the engine, the torrent list, a torrent's status
  /^GET \/v1\/health$/,
  /^GET \/v1\/torrents(\/[^/]+)?$/,
  /^(GET|HEAD) \/v1\/torrents\/[^/]+\/files\/\d+\/stream$/,
  /^GET \/v1\/playback\/[^/]+\/(index\.m3u8|init\.mp4|seg_\d+\.m4s)$/,
  /^POST \/v1\/playback\/[^/]+\/heartbeat$/,
  // Continue watching's pictures, every time Home shows
  /^GET \/v1\/library\/[^/]+\/files\/\d+\/thumbnail$/,
  /^(GET|HEAD) \/internal\/files\/[^/]+$/,
];

export function isQuietRequest(method: string, url: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  return QUIET_REQUESTS.some((pattern) => pattern.test(`${method} ${path}`));
}

export function createApp(options: { secret: string }): Express {
  const app = express();

  app.disable("x-powered-by");
  // Not behind a proxy that sets X-Forwarded-*: never believe those headers.
  app.set("trust proxy", false);

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        // Express sets originalUrl (req.url loses the /v1 inside routers).
        const { method, originalUrl } = req as express.Request;
        return isQuietRequest(method, originalUrl) ? "silent" : "info";
      },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          // Never a file token (the logger redacts too; this is cheap).
          url: redact(req.url),
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        // A 500's error, without the file paths it may carry.
        err: serializeError,
      },
    }),
  );
  app.use(requireLoopbackHost);
  app.use(express.json({ limit: "1mb" }));

  app.get("/internal/files/:token", internalFilesGet.handler);
  app.use("/v1", requireSecret(options.secret), v1Router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
