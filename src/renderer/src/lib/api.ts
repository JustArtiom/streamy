import {
  type ApiError,
  type CacheInfo,
  type CreatePlaybackRequest,
  type Cue,
  ENGINE_API_BASE,
  ErrorCode,
  type HeartbeatRequest,
  type Health,
  type Library,
  type LibraryTorrentDetail,
  type MediaInfo,
  type Playback,
  type PlaybackStatus,
  type FileProgress,
  type ProgressUpdate,
  type SubtitleCuesResponse,
  type TorrentDetail,
  type ValidationIssue,
} from "../../../shared/engine-api";
import { isEngineRunning } from "@/lib/engine-status";
import { looksTechnical, SOMETHING_WENT_WRONG } from "@/lib/people-text";

// The UI's only way to the playback engine. Every call is a fetch() to
// app://streamy/api/v1/…; the main process forwards it to the engine.
// Paths and types are the contract in src/shared/engine-api.ts.

/**
 * Turns an API path ("/v1/…") into a URL the page can fetch. Also for the
 * URLs the API returns (Playback.url, thumbnailUrl…), which start with "/v1/".
 * Always absolute: in dev the page comes from the Vite server, so a relative
 * URL would go there instead of to the engine.
 */
export function engineUrl(path: string): string {
  return `${ENGINE_API_BASE}${path}`;
}

/**
 * A request that failed. `status` 0 = it never got an answer.
 * `code` is the engine's ErrorCode, or one of ours ("NETWORK", "UNKNOWN").
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(
    status: number,
    code: string,
    message: string,
    issues: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

/**
 * The engine isn't there right now (it's starting, restarting or keeps
 * crashing): the main process answered for it with a 503. Worth retrying
 * once it's back; React Query pauses until then (see query-client.ts).
 */
export class EngineUnavailableError extends ApiRequestError {
  constructor() {
    super(
      503,
      ErrorCode.ServiceUnavailable,
      "The playback engine isn't running right now. Streamy is starting it again.",
    );
    this.name = "EngineUnavailableError";
  }
}

export function isApiError(
  error: unknown,
  status?: number,
): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    (status === undefined || error.status === status)
  );
}

export function isEngineUnavailable(error: unknown): boolean {
  return error instanceof EngineUnavailableError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Text written for developers rather than people: route names ("Route GET
 * /v1/library not found"), API paths, parser errors. Never shown. (System
 * errors, stack traces and paths are caught by looksTechnical.)
 */
const DEVELOPER_TEXT = /^Route |\/v1\/|JSON|request body|^Request failed/i;

/** Text an error can show as it is (not developer text). */
export function isForPeople(text: string): boolean {
  return !looksTechnical(text) && !DEVELOPER_TEXT.test(text);
}

/** Errors whose details went to the console already (renders repeat). */
const logged = new WeakSet<object>();

function logDetails(error: unknown) {
  if (typeof error !== "object" || error === null || logged.has(error)) return;
  logged.add(error);
  console.warn("Shown as a general error message:", error);
}

/**
 * A message for people, whatever was thrown. The engine's own messages are
 * written for people ("Too many videos are being converted right now") and
 * show as they are. Anything else (a crash inside the engine, a missing
 * route, a bug here) becomes a plain sentence; its details go to the
 * console instead.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === ErrorCode.ValidationFailed) {
      const issue = error.issues.find((item) => isForPeople(item.message));
      if (issue) return issue.message;
    }
    if (error.code === ErrorCode.Internal) {
      logDetails(error);
      return "The playback engine ran into a problem. Please try again.";
    }
    if (error.code !== "UNKNOWN" && isForPeople(error.message)) {
      return error.message;
    }
  }
  logDetails(error);
  return SOMETHING_WENT_WRONG;
}

type ApiInit = Omit<RequestInit, "body"> & {
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is (e.g. a .torrent file). */
  body?: BodyInit;
};

/**
 * fetch() for the engine API: JSON in and out, and every failure becomes an
 * ApiRequestError carrying the engine's own message.
 */
export async function apiFetch<T>(path: string, init: ApiInit = {}) {
  const { json, headers, ...rest } = init;
  const finalHeaders = new Headers(headers);
  if (json !== undefined) finalHeaders.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(engineUrl(path), {
      ...rest,
      headers: finalHeaders,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (error) {
    // Aborts are on purpose (e.g. leaving the page); let callers tell them apart.
    if (isAbortError(error)) throw error;
    throw new ApiRequestError(
      0,
      "NETWORK",
      "Can't reach the playback engine. Try again in a moment.",
    );
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function toApiError(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  if (isApiErrorBody(body)) {
    const { code, message, issues } = body.error;
    if (isEngineMissing(response.status, code)) {
      return new EngineUnavailableError();
    }
    return new ApiRequestError(response.status, code, message, issues ?? []);
  }
  if (response.status >= 500) {
    return new ApiRequestError(
      response.status,
      "NETWORK",
      "The playback engine isn't responding. Try again in a moment.",
    );
  }
  return new ApiRequestError(
    response.status,
    "UNKNOWN",
    `Request failed (${response.status})`,
  );
}

/**
 * The main process answered for the engine (src/main/engine/proxy.ts):
 * - 503 while it isn't running. The engine also answers 503 itself (no
 *   ffmpeg, disk full…), but then it's running.
 * - 502 when it couldn't reach it (it stopped mid-request). Only the main
 *   process sends 502.
 */
function isEngineMissing(status: number, code: string) {
  if (code !== ErrorCode.ServiceUnavailable) return false;
  return status === 502 || (status === 503 && !isEngineRunning());
}

function isApiErrorBody(body: unknown): body is ApiError {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }
  const error = body.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    "code" in error &&
    typeof error.code === "string"
  );
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

const torrentPath = (infoHash: string) =>
  `/v1/torrents/${encodeURIComponent(infoHash)}`;
const filePath = (infoHash: string, fileIndex: number) =>
  `${torrentPath(infoHash)}/files/${fileIndex}`;
const libraryPath = (infoHash: string) =>
  `/v1/library/${encodeURIComponent(infoHash)}`;

export const api = {
  // Health
  getHealth: (signal?: AbortSignal) =>
    apiFetch<Health>("/v1/health", { signal }),

  // Torrents
  /** 404 when it isn't active anymore: addMagnet(infoHash) re-opens it. */
  getTorrent: (infoHash: string, signal?: AbortSignal) =>
    apiFetch<{ torrent: TorrentDetail }>(torrentPath(infoHash), {
      signal,
    }).then((data) => data.torrent),

  /** A magnet link or a bare info hash (also re-opens a known torrent). */
  addMagnet: (magnet: string, signal?: AbortSignal) =>
    apiFetch<{ torrent: TorrentDetail }>("/v1/torrents", {
      method: "POST",
      json: { magnet },
      signal,
    }).then((data) => data.torrent),

  addTorrentFile: (file: Blob) =>
    apiFetch<{ torrent: TorrentDetail }>("/v1/torrents/file", {
      method: "POST",
      headers: { "Content-Type": "application/x-bittorrent" },
      body: file,
    }).then((data) => data.torrent),

  /**
   * Stops it and deletes its downloaded data. `forget` also removes it from
   * the library (Recent, Continue watching, saved positions).
   */
  removeTorrent: (infoHash: string, { forget = false } = {}) =>
    apiFetch<undefined>(
      forget ? `${torrentPath(infoHash)}?forget=true` : torrentPath(infoHash),
      { method: "DELETE" },
    ),

  /** The raw file, for <video> direct play (supports Range). */
  streamUrl: (infoHash: string, fileIndex: number) =>
    engineUrl(`${filePath(infoHash, fileIndex)}/stream`),

  // Media
  getMedia: (infoHash: string, fileIndex: number, signal?: AbortSignal) =>
    apiFetch<{ media: MediaInfo }>(`${filePath(infoHash, fileIndex)}/media`, {
      signal,
    }).then((data) => data.media),

  getFileSubtitles: (
    infoHash: string,
    fileIndex: number,
    signal?: AbortSignal,
  ) =>
    apiFetch<{ cues: Cue[] }>(`${filePath(infoHash, fileIndex)}/subtitles`, {
      signal,
    }).then((data) => data.cues),

  // Playback
  createPlayback: (request: CreatePlaybackRequest, signal?: AbortSignal) =>
    apiFetch<{ playback: Playback }>("/v1/playback", {
      method: "POST",
      json: request,
      signal,
    }).then((data) => data.playback),

  heartbeat: (id: string, body: HeartbeatRequest) =>
    apiFetch<{ status: PlaybackStatus }>(
      `/v1/playback/${encodeURIComponent(id)}/heartbeat`,
      { method: "POST", json: body },
    ).then((data) => data.status),

  /**
   * keepalive lets the request finish while the page unloads (closing the
   * window still stops ffmpeg). Errors don't matter: the engine also stops
   * sessions nobody sends heartbeats for.
   */
  deletePlayback: (id: string) =>
    fetch(engineUrl(`/v1/playback/${encodeURIComponent(id)}`), {
      method: "DELETE",
      keepalive: true,
    }).then(
      () => undefined,
      () => undefined,
    ),

  /**
   * Stops every session of a player, including a start still in progress.
   * Best effort (keepalive): it's sent while the player closes.
   */
  deletePlayer: (playerId: string) =>
    fetch(engineUrl(`/v1/players/${encodeURIComponent(playerId)}`), {
      method: "DELETE",
      keepalive: true,
    }).then(
      () => undefined,
      () => undefined,
    ),

  getPlaybackSubtitles: (
    id: string,
    stream: number,
    from: number,
    to: number,
    signal?: AbortSignal,
  ) =>
    apiFetch<SubtitleCuesResponse>(
      `/v1/playback/${encodeURIComponent(id)}/subtitles/${stream}?from=${from.toFixed(1)}&to=${to.toFixed(1)}`,
      { signal },
    ),

  // Library
  getLibrary: (signal?: AbortSignal) =>
    apiFetch<Library>("/v1/library", { signal }),

  /** null when the library doesn't know this torrent. */
  getLibraryTorrent: (infoHash: string, signal?: AbortSignal) =>
    apiFetch<LibraryTorrentDetail>(libraryPath(infoHash), { signal }).catch(
      (error: unknown) => {
        if (isApiError(error, 404)) return null;
        throw error;
      },
    ),

  /**
   * `keepalive` lets it finish while the page unloads (the player saving
   * its position as the window closes).
   */
  saveProgress: (
    infoHash: string,
    fileIndex: number,
    update: ProgressUpdate,
    { keepalive = false }: { keepalive?: boolean } = {},
  ) =>
    apiFetch<{ progress: FileProgress }>(
      `${libraryPath(infoHash)}/files/${fileIndex}`,
      { method: "PUT", json: update, keepalive },
    ).then((data) => data.progress),

  /** Removes a file from Continue watching (forgets its position). */
  removeProgress: (infoHash: string, fileIndex: number) =>
    apiFetch<undefined>(`${libraryPath(infoHash)}/files/${fileIndex}`, {
      method: "DELETE",
    }),

  /** Forgets a torrent: same as removeTorrent(infoHash, { forget: true }). */
  forgetTorrent: (infoHash: string) =>
    apiFetch<undefined>(libraryPath(infoHash), { method: "DELETE" }),

  // Cache (the video folder)
  getCache: (signal?: AbortSignal) =>
    apiFetch<CacheInfo>("/v1/cache", { signal }),

  clearCache: () => apiFetch<undefined>("/v1/cache/clear", { method: "POST" }),
};
