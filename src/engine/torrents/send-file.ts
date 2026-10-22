import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { contentType } from "../lib/file-kind";
import { logger } from "../lib/logger";
import { parseRange } from "../lib/range";
import { type ReadGate, TOKEN_REVOKED } from "./file-tokens";
import type { TorrentFileHandle } from "./service";

// What a reader going away looks like. That's normal here: every seek in
// the player and every ffmpeg seek closes a connection mid-file. So is a
// playback ending while its ffmpeg's read was held back (token revoked).
const CLIENT_GONE = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ABORT_ERR",
  TOKEN_REVOKED,
]);

/**
 * A gated read is let through in slices of this size: a torrent's chunks
 * can be whole pieces (up to 16 MB, many seconds of video).
 */
const GATE_SLICE_BYTES = 256 * 1024;

function isClientGone(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    (code !== undefined && CLIENT_GONE.has(code)) ||
    err.name === "AbortError" ||
    err.message === "aborted"
  );
}

/** Passes the bytes on as `gate` lets them through (`signal`: the reader left). */
function throughGate(gate: ReadGate, signal: AbortSignal) {
  return async function* (
    chunks: AsyncIterable<Buffer>,
  ): AsyncGenerator<Buffer> {
    for await (const chunk of chunks) {
      for (let at = 0; at < chunk.length; at += GATE_SLICE_BYTES) {
        const slice = chunk.subarray(at, at + GATE_SLICE_BYTES);
        await gate.pass(slice.length, signal);
        yield slice;
      }
    }
  };
}

/**
 * Answers a GET/HEAD for a torrent file's bytes, with Range support (206,
 * 416). Reading a range makes its pieces urgent; the reader going away
 * (a seek) drops them again. HEAD sends the same headers and starts no read
 * (a read would start downloading).
 *
 * Used by /v1/…/stream (the player's direct play) and /internal/files/
 * (ffmpeg and ffprobe). `gate` (internal reads only) can hold the bytes
 * back: a playback's ffmpeg then waits in read() until they're let through.
 */
export async function sendTorrentFile(
  req: Request,
  res: Response,
  file: TorrentFileHandle,
  options: { gate?: ReadGate } = {},
): Promise<void> {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType(file.name));
  res.setHeader("Cache-Control", "no-store");

  if (file.size === 0) {
    res.status(200).setHeader("Content-Length", 0).end();
    return;
  }

  const range = parseRange(req.headers.range, file.size);
  if (range.type === "unsatisfiable") {
    res.status(416).setHeader("Content-Range", `bytes */${file.size}`).end();
    return;
  }

  const { start, end } =
    range.type === "range" ? range : { start: 0, end: file.size - 1 };
  if (range.type === "range") {
    res
      .status(206)
      .setHeader("Content-Range", `bytes ${start}-${end}/${file.size}`);
  } else {
    res.status(200);
  }
  res.setHeader("Content-Length", end - start + 1);

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  // Outside the try: a torrent removed meanwhile is a proper error answer.
  const source = file.createReadStream({ start, end });
  try {
    if (options.gate) {
      // A reader that leaves while held back mustn't stay waiting.
      const gone = new AbortController();
      res.once("close", () => {
        gone.abort();
      });
      await pipeline(source, throughGate(options.gate, gone.signal), res);
    } else {
      await pipeline(source, res);
    }
  } catch (err) {
    // The response is already under way (or the connection closed):
    // nothing more can be sent, pipeline has closed both ends.
    if (!isClientGone(err)) {
      logger.warn(
        { err, infoHash: file.infoHash, fileIndex: file.index },
        "Stream stopped",
      );
    }
  }
}
