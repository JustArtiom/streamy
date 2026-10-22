import { z } from "zod";
import type { CacheInfo } from "../../shared/engine-api";
import { ENGINE_SECRET_HEADER } from "../../shared/engine-protocol";
import type { ActionResult, CacheUsage } from "../../shared/settings";
import type { Logger } from "../logs";
import type { EngineConnection, EngineHost } from "./host";

// The main process's own calls to the engine (Settings → Storage, .torrent
// files opened from the OS). Straight to its loopback port with the secret,
// not through app://: that's the page's way in.

/** A call to the engine that didn't work. The message is meant for people. */
export class EngineRequestError extends Error {
  override name = "EngineRequestError";
  /** The engine's HTTP status, or null if it couldn't be reached. */
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

interface CallOptions {
  method?: "GET" | "POST";
  body?: Uint8Array;
  contentType?: string;
  timeoutMs?: number;
}

const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** Calls the engine's HTTP API and returns the parsed JSON body (if any). */
export async function callEngine(
  { port, secret }: EngineConnection,
  path: string,
  { method = "GET", body, contentType, timeoutMs = 10_000 }: CallOptions = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        [ENGINE_SECRET_HEADER]: secret,
        accept: "application/json",
        ...(contentType ? { "content-type": contentType } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new EngineRequestError(
      "Streamy couldn't reach the playback engine. Try again in a moment.",
      null,
    );
  }

  const text = await response.text().catch(() => "");
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON: only the status matters then.
    }
  }
  if (!response.ok) {
    const apiError = apiErrorSchema.safeParse(data);
    throw new EngineRequestError(
      apiError.success
        ? apiError.data.error.message
        : `The playback engine couldn't do that (error ${response.status}).`,
      response.status,
    );
  }
  return data;
}

const cacheInfoSchema = z.object({
  dir: z.string(),
  exists: z.boolean(),
  usedBytes: z.number().nonnegative(),
  limitBytes: z.number().nullable(),
  freeBytes: z.number().nullable(),
  lowDiskSpace: z.boolean(),
}) satisfies z.ZodType<CacheInfo>;

const addedTorrentSchema = z.object({
  torrent: z.object({ infoHash: z.string().regex(/^[0-9a-f]{40}$/) }),
});

/** Adds a .torrent file's bytes to the engine. Returns its info hash. */
export async function addTorrentFile(
  connection: EngineConnection,
  bytes: Uint8Array,
): Promise<string> {
  const data = await callEngine(connection, "/v1/torrents/file", {
    method: "POST",
    body: bytes,
    contentType: "application/x-bittorrent",
    timeoutMs: 60_000,
  });
  const parsed = addedTorrentSchema.safeParse(data);
  if (!parsed.success) {
    throw new EngineRequestError(
      "The playback engine gave an answer Streamy doesn't understand.",
      200,
    );
  }
  return parsed.data.torrent.infoHash;
}

/** What Settings → Storage needs from the engine (see settings/index.ts). */
export interface CacheEngine {
  /**
   * Space used in `dir`, as the engine measures it. null when it can't tell
   * (not running, an older engine, another folder): measure locally instead.
   */
  usage: (dir: string) => Promise<CacheUsage | null>;
  /** Deletes the downloaded videos (the engine stops its torrents first). */
  clear: () => Promise<ActionResult>;
}

const NOT_RUNNING: ActionResult = {
  status: "error",
  message: "The playback engine isn't running. Try again in a moment.",
};

export function createCacheEngine(
  host: Pick<EngineHost, "connection">,
  log: Logger,
): CacheEngine {
  return {
    usage: async (dir) => {
      const connection = host.connection();
      if (!connection) return null;
      try {
        const info = cacheInfoSchema.parse(
          await callEngine(connection, "/v1/cache"),
        );
        // Right after a folder change the engine may not have switched yet.
        if (info.dir !== dir) return null;
        return info.exists
          ? { status: "ok", bytes: info.usedBytes }
          : { status: "missing" };
      } catch (error) {
        log.warn(
          { err: error },
          "Could not get the video folder's usage from the engine",
        );
        return null;
      }
    },
    clear: async () => {
      const connection = host.connection();
      if (!connection) return NOT_RUNNING;
      try {
        await callEngine(connection, "/v1/cache/clear", {
          method: "POST",
          // Deleting many gigabytes can take a while.
          timeoutMs: 120_000,
        });
        return { status: "ok" };
      } catch (error) {
        log.warn({ err: error }, "Clearing the video folder failed");
        if (error instanceof EngineRequestError) {
          return {
            status: "error",
            message:
              error.status === 404
                ? "This version of the playback engine can't clear videos yet."
                : error.message,
          };
        }
        throw error;
      }
    },
  };
}
