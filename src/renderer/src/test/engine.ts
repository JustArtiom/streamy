import { vi } from "vitest";
import { ENGINE_API_BASE, type ErrorCode } from "../../../shared/engine-api";
import { health, library } from "@/test/fixtures";

// A stand-in for the playback engine in UI tests: fetch() to
// app://streamy/api/… answers from a table of routes, and every call is
// recorded. Restored after each test (restoreMocks in vitest.config.mts).

export type EngineCall = {
  method: string;
  /** "/v1/torrents/abc?forget=true" (without the API base). */
  path: string;
  /** The parsed JSON body, or the raw body (e.g. a .torrent Blob). */
  body: unknown;
};

/** A JSON body the engine could send. */
type Json = Record<string, unknown> | unknown[];

/** What a route answers: a Response, a JSON body, or a function of the call. */
export type EngineAnswer =
  | Response
  | Json
  | ((call: EngineCall) => Response | Json | Promise<Response | Json>);

/** A JSON Response, like the engine sends. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An ApiError response, e.g. engineError(404, "NOT_FOUND", "Torrent not found"). */
export function engineError(
  status: number,
  code: ErrorCode,
  message: string,
  issues?: { path: string; message: string }[],
): Response {
  return jsonResponse({ error: { code, message, issues } }, status);
}

export const noContent = () => new Response(null, { status: 204 });

/**
 * Requests no route answered, since the last check. setup.ts fails the test
 * with them: a made-up answer (say, a 404) would hide bugs, since a 404
 * means something here (e.g. "re-open this torrent").
 */
const unanswered: string[] = [];

/** The unanswered requests so far, and forgets them (see setup.ts). */
export function takeUnansweredEngineCalls(): string[] {
  return unanswered.splice(0);
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body ?? null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

const HASH_OR_ID = "[^/?]+";

/**
 * What a fresh, healthy engine with an empty library answers to the
 * requests pages make in the background (the banner's health check, the
 * library, a player cleaning up as it closes). A test's own routes win.
 * Nothing about torrents or playback: those must be in the test.
 */
const BACKGROUND: [RegExp, () => Response][] = [
  [/^GET \/v1\/health$/, () => jsonResponse(health())],
  [/^GET \/v1\/library$/, () => jsonResponse(library())],
  // 404 here is "the library doesn't know it", which the UI shows as such.
  [
    new RegExp(`^GET /v1/library/${HASH_OR_ID}$`),
    () => engineError(404, "NOT_FOUND", "This torrent isn't in the library"),
  ],
  [new RegExp(`^DELETE /v1/players/${HASH_OR_ID}$`), noContent],
  [new RegExp(`^DELETE /v1/playback/${HASH_OR_ID}$`), noContent],
];

function backgroundAnswer(method: string, path: string): Response | null {
  const key = `${method} ${path}`;
  const match = BACKGROUND.find(([pattern]) => pattern.test(key));
  return match ? match[1]() : null;
}

/**
 * Answers fetch() from `routes`, keyed "METHOD /path". A key with a query
 * string ("DELETE /v1/torrents/abc?forget=true") wins over one without.
 * Background requests get a healthy engine's answer (see BACKGROUND).
 * Anything else fails the test: give every route the test uses an answer,
 * e.g. engineError(404, "NOT_FOUND", "Torrent not found") for a real 404.
 */
export function mockEngine(routes: Record<string, EngineAnswer> = {}) {
  const calls: EngineCall[] = [];
  const table = new Map(Object.entries(routes));

  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.startsWith(ENGINE_API_BASE)) {
        throw new Error(`Unexpected fetch outside the engine: ${url}`);
      }
      const path = url.slice(ENGINE_API_BASE.length);
      const method = init?.method ?? "GET";
      const call: EngineCall = { method, path, body: parseBody(init?.body) };
      calls.push(call);

      const answer =
        table.get(`${method} ${path}`) ??
        table.get(`${method} ${path.split("?")[0] ?? path}`);
      if (answer === undefined) {
        const background = backgroundAnswer(method, path);
        if (background) return background;
        unanswered.push(`${method} ${path}`);
        // To the page this looks like a network failure; the test fails
        // after it ends, naming the route (setup.ts).
        throw new TypeError(
          `The fake engine has no route for ${method} ${path}`,
        );
      }
      const value = typeof answer === "function" ? await answer(call) : answer;
      // A fresh Response every time: a body can only be read once.
      if (value instanceof Response) return value.clone();
      return jsonResponse(value);
    });

  return {
    fetch: fetchMock,
    calls,
    /** Changes (or adds) a route while the test runs. */
    on(key: string, answer: EngineAnswer) {
      table.set(key, answer);
    },
    /** The calls to one route, e.g. callsTo("POST /v1/torrents"). */
    callsTo(key: string) {
      return calls.filter((call) => {
        const [method, path] = key.split(" ");
        return (
          call.method === method &&
          (call.path === path || call.path.split("?")[0] === path)
        );
      });
    },
  };
}
