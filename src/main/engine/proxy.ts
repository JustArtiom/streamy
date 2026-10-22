import {
  Agent,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request as httpRequest,
} from "node:http";
import { Readable } from "node:stream";
import { type ApiError, ErrorCode } from "../../shared/engine-api";
import { ENGINE_SECRET_HEADER } from "../../shared/engine-protocol";
import type { EngineConnection } from "./host";

// app://streamy/api/* → the engine's loopback HTTP server (PLAN §3.3, §5.2).
// The page never learns the engine's port or secret: this adds the secret,
// and only lets through the headers the API needs, in both directions.
// Bodies are streamed both ways.
//
// Cancelling: once an answer has started, the page stopping to read it (a
// seek, a closed player) closes the engine's response too. Before that, the
// page can't cancel anything: Electron 45 never fires `request.signal` for
// protocol.handle requests (an aborted fetch still runs here until the
// engine answers). So the player stops its own work by id instead (DELETE
// /v1/players/:id), and commands get COMMAND_TIMEOUT_MS at most.

/**
 * How long a command (anything but GET/HEAD) may wait for the engine's
 * answer before the page is told it took too long. The slowest one, starting
 * playback, gives up after 2 minutes on its own. Reads have no limit: video
 * bytes and subtitles wait for the torrent, which can be slow, and blocking
 * playlist reloads end after about 12 s anyway.
 */
export const COMMAND_TIMEOUT_MS = 130_000;

/** Request headers passed on to the engine. Anything else is dropped. */
export const FORWARDED_REQUEST_HEADERS = [
  "range",
  "if-range",
  "content-type",
  "content-length",
  "accept",
  "if-none-match",
  "if-modified-since",
] as const;

/** Response headers passed back to the page. */
export const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "x-request-id",
] as const;

const NOT_RUNNING = "The playback engine isn't running. Try again in a moment.";
const UNREACHABLE =
  "Streamy couldn't reach the playback engine. Try again in a moment.";
const TOO_SLOW =
  "The playback engine took too long to answer. Try again in a moment.";

/** On every answer: the page must never guess a type the engine didn't send. */
const SECURITY_HEADERS = { "x-content-type-options": "nosniff" } as const;

/** Changes something in the engine (saving progress, deleting…). */
function isCommand(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

export interface ApiProxyOptions {
  /** How to reach the engine, or null while it isn't running. */
  engine: () => EngineConnection | null;
  /**
   * Dev only: the Vite dev server's origin. The page comes from there, so its
   * calls to app://streamy/api are cross-origin. What makes them work is the
   * scheme's `corsEnabled` privilege (protocol.ts): Electron 45 doesn't check
   * the CORS headers of app:// answers. They're added anyway, for this
   * origin only, so dev keeps working if a later Electron does check them.
   */
  devOrigin?: string;
  /** Tests: a shorter COMMAND_TIMEOUT_MS. */
  commandTimeoutMs?: number;
}

export interface IdleOptions {
  /** No command may have been waiting for this long. */
  quietMs: number;
  /** Resolves after this long anyway. */
  maxMs: number;
}

export interface ApiProxy {
  /**
   * Answers a request for app://streamy/api<path>. `path` is the rest of the
   * URL, still percent-encoded, with its query ("/v1/torrents?x=1").
   */
  handle: (request: Request, path: string) => Promise<Response>;
  /** Commands (anything but GET/HEAD) sent on and not answered yet. */
  pendingCommands: () => number;
  /**
   * Resolves once the engine has answered every command and no new one came
   * for `quietMs` (at quit: the last save of a closing player is on its way),
   * or after `maxMs`, whichever comes first.
   */
  whenIdle: (options: IdleOptions) => Promise<void>;
  /** Closes idle connections to the engine (at quit, and in tests). */
  close: () => void;
}

export function createApiProxy({
  engine,
  devOrigin,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
}: ApiProxyOptions): ApiProxy {
  // Keep-alive: the player makes many small requests (HLS segments). No
  // socket limit: long-held requests (HLS playlist reloads) must never make
  // others queue behind them.
  const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
  // Headers every answer gets.
  const always: Record<string, string> = {
    ...SECURITY_HEADERS,
    ...(devOrigin && {
      "access-control-allow-origin": devOrigin,
      "access-control-expose-headers": FORWARDED_RESPONSE_HEADERS.join(", "),
    }),
  };
  let pending = 0;
  /** Called whenever a command starts or gets its answer (see whenIdle). */
  const changeListeners = new Set<() => void>();
  const changed = () => {
    for (const listener of changeListeners) listener();
  };

  const handle = async (request: Request, path: string): Promise<Response> => {
    // A CORS preflight from the dev page. Answered here: the engine doesn't
    // know about CORS.
    if (devOrigin && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...always,
          "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
          "access-control-allow-headers": FORWARDED_REQUEST_HEADERS.join(", "),
          "access-control-max-age": "600",
        },
      });
    }

    const connection = engine();
    if (!connection) {
      return errorResponse(
        503,
        ErrorCode.ServiceUnavailable,
        NOT_RUNNING,
        always,
      );
    }
    const command = isCommand(request.method);
    if (command) {
      pending++;
      changed();
    }
    try {
      return await forward(request, path, connection, agent, always, {
        timeoutMs: command ? commandTimeoutMs : null,
      });
    } catch {
      // http.request refuses some URLs outright (e.g. characters it won't send).
      return errorResponse(400, ErrorCode.BadRequest, "Bad request.", always);
    } finally {
      if (command) {
        pending--;
        changed();
      }
    }
  };

  const whenIdle = ({ quietMs, maxMs }: IdleOptions) =>
    new Promise<void>((resolve) => {
      let quietTimer: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        changeListeners.delete(check);
        resolve();
      };
      // Every change starts the quiet period over.
      const check = () => {
        clearTimeout(quietTimer);
        if (pending === 0) quietTimer = setTimeout(done, quietMs);
      };
      const maxTimer = setTimeout(done, maxMs);
      changeListeners.add(check);
      check();
    });

  return {
    handle,
    pendingCommands: () => pending,
    whenIdle,
    close: () => {
      agent.destroy();
    },
  };
}

function forward(
  request: Request,
  path: string,
  { port, secret }: EngineConnection,
  agent: Agent,
  always: Record<string, string>,
  { timeoutMs }: { timeoutMs: number | null },
): Promise<Response> {
  const headers: OutgoingHttpHeaders = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  // Ours, never the page's: a page-sent secret was dropped above.
  headers[ENGINE_SECRET_HEADER] = secret;

  // Every failure resolves to an error response, except http.request
  // throwing right away (the caller turns that into a 400).
  return new Promise<Response>((resolve) => {
    const upstream = httpRequest({
      host: "127.0.0.1",
      port,
      method: request.method,
      path: path.startsWith("/") ? path : `/${path}`,
      headers,
      agent,
    });

    // Only the first answer counts (an error after a timeout, say).
    let timer: NodeJS.Timeout | undefined;
    let answered = false;
    const answer = (response: Response) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve(response);
    };

    upstream.on("response", (response: IncomingMessage) => {
      if (answered) {
        response.destroy();
        return;
      }
      answer(toResponse(request, response, always));
    });
    // Before a response: the engine is gone or refused the connection.
    // After one, errors reach the page through the body stream instead.
    upstream.on("error", () => {
      answer(
        errorResponse(502, ErrorCode.ServiceUnavailable, UNREACHABLE, always),
      );
    });
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        answer(
          errorResponse(504, ErrorCode.ServiceUnavailable, TOO_SLOW, always),
        );
        upstream.destroy();
      }, timeoutMs);
    }

    // The page gave up before the answer came: stop the engine's work too.
    // Electron 45 never fires this signal for protocol.handle requests (see
    // the top of this file); kept for when it does.
    const onAbort = () => upstream.destroy();
    request.signal.addEventListener("abort", onAbort, { once: true });
    upstream.once("close", () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    });

    if (request.body) {
      // A .torrent upload (up to 10 MB) or JSON, streamed as it arrives.
      const body = Readable.fromWeb(request.body);
      body.once("error", (error) => upstream.destroy(error));
      body.pipe(upstream);
    } else {
      upstream.end();
    }
  });
}

function toResponse(
  request: Request,
  response: IncomingMessage,
  always: Record<string, string>,
): Response {
  const status = response.statusCode ?? 502;
  if (status < 200 || status > 599) {
    response.destroy();
    return errorResponse(
      502,
      ErrorCode.ServiceUnavailable,
      UNREACHABLE,
      always,
    );
  }
  const headers = new Headers(always);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  // These must not have a body (Response throws if given one).
  if (request.method === "HEAD" || status === 204 || status === 304) {
    response.resume();
    return new Response(null, { status, headers });
  }
  // When the page stops reading, the web stream is canceled, which destroys
  // `response` and closes the connection: the engine sees the request end.
  return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
    status,
    headers,
  });
}

/** An ApiError response, the same shape the engine uses for its errors. */
export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body: ApiError = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...extraHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
}
