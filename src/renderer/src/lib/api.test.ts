import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  api,
  apiFetch,
  ApiRequestError,
  engineUrl,
  errorMessage,
  isApiError,
  isEngineUnavailable,
} from "@/lib/api";
import {
  engineError,
  jsonResponse,
  mockEngine,
  noContent,
} from "@/test/engine";
import { fakeStreamy } from "@/test/fake-streamy";

const BASE = "app://streamy/api";

function mockFetch() {
  return vi.spyOn(globalThis, "fetch");
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject");
}

describe("engineUrl", () => {
  it("puts the absolute engine base in front of /v1 paths", () => {
    expect(engineUrl("/v1/torrents")).toBe(`${BASE}/v1/torrents`);
    expect(engineUrl("/v1/library/abc/files/0/thumbnail")).toBe(
      `${BASE}/v1/library/abc/files/0/thumbnail`,
    );
  });
});

describe("apiFetch", () => {
  it("returns the JSON body", async () => {
    const fetchMock = mockFetch().mockResolvedValue(
      jsonResponse({ torrents: [] }),
    );

    await expect(apiFetch("/v1/torrents")).resolves.toEqual({ torrents: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/v1/torrents`);
  });

  it("sends `json` as a JSON body", async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({ ok: 1 }));

    await apiFetch("/v1/torrents", { method: "POST", json: { magnet: "m" } });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"magnet":"m"}');
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("turns an ApiError body into an ApiRequestError", async () => {
    mockFetch().mockResolvedValue(
      engineError(400, "VALIDATION_FAILED", "Some fields are invalid", [
        { path: "body.magnet", message: "Invalid magnet link" },
      ]),
    );

    const error = await rejection(apiFetch("/v1/torrents"));

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Some fields are invalid",
      issues: [{ path: "body.magnet", message: "Invalid magnet link" }],
    });
    expect(isApiError(error, 400)).toBe(true);
    expect(isApiError(error, 404)).toBe(false);
    // The field's own message says more than "Some fields are invalid".
    expect(errorMessage(error)).toBe("Invalid magnet link");
  });

  it("has no issues when the engine sent none", async () => {
    mockFetch().mockResolvedValue(
      engineError(404, "NOT_FOUND", "Torrent not found"),
    );

    const error = await rejection(apiFetch("/v1/torrents/abc"));
    expect(error).toMatchObject({ status: 404, issues: [] });
  });

  it("recognises the main process answering for a stopped engine", async () => {
    act(() => {
      fakeStreamy.setEngineStatus({ state: "restarting", error: "Crashed" });
    });
    mockFetch().mockResolvedValue(
      engineError(503, "SERVICE_UNAVAILABLE", "The engine is restarting"),
    );

    const error = await rejection(apiFetch("/v1/library"));

    expect(isEngineUnavailable(error)).toBe(true);
    expect(isApiError(error, 503)).toBe(true);
    expect(errorMessage(error)).toMatch(/playback engine isn't running/);
  });

  it("recognises the main process failing to reach the engine (502)", async () => {
    mockFetch().mockResolvedValue(
      engineError(502, "SERVICE_UNAVAILABLE", "Couldn't reach the engine"),
    );

    const error = await rejection(apiFetch("/v1/library"));

    expect(isEngineUnavailable(error)).toBe(true);
  });

  it("keeps the engine's own 503s (e.g. no ffmpeg) as they are", async () => {
    mockFetch().mockResolvedValue(
      engineError(503, "SERVICE_UNAVAILABLE", "ffmpeg isn't available"),
    );

    const error = await rejection(apiFetch("/v1/playback"));

    expect(isEngineUnavailable(error)).toBe(false);
    expect(errorMessage(error)).toBe("ffmpeg isn't available");
  });

  it("says the engine isn't responding for a 5xx without JSON", async () => {
    mockFetch().mockResolvedValue(new Response("Bad gateway", { status: 502 }));

    const error = await rejection(apiFetch("/v1/torrents"));
    expect(error).toMatchObject({ status: 502, code: "NETWORK" });
    expect(errorMessage(error)).toMatch(/isn't responding/);
  });

  it("gives a generic message for other errors without JSON", async () => {
    mockFetch().mockResolvedValue(new Response("", { status: 418 }));

    const error = await rejection(apiFetch("/v1/torrents"));
    expect(error).toMatchObject({
      status: 418,
      message: "Request failed (418)",
    });
    expect(errorMessage(error)).toBe("Something went wrong. Please try again.");
  });

  it("uses status 0 when the request never got an answer", async () => {
    mockFetch().mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await rejection(apiFetch("/v1/torrents"));
    expect(error).toMatchObject({ status: 0, code: "NETWORK" });
    expect(errorMessage(error)).toMatch(/Can't reach the playback engine/);
  });

  it("lets aborts through untouched", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    mockFetch().mockRejectedValue(abort);

    await expect(apiFetch("/v1/playback")).rejects.toBe(abort);
  });

  it("returns undefined for 204 No Content", async () => {
    mockFetch().mockResolvedValue(noContent());

    await expect(
      apiFetch("/v1/torrents/abc", { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });
});

describe("errorMessage", () => {
  it("has something to say for anything thrown", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      // Details for the console only.
    });
    expect(errorMessage(new Error("Boom"))).toMatch(/Something went wrong/);
    expect(errorMessage("nope")).toMatch(/Something went wrong/);
    expect(errorMessage(new Error(""))).toMatch(/Something went wrong/);
  });
});

describe("api", () => {
  it("unwraps the response envelopes", async () => {
    mockEngine({ "GET /v1/torrents/abc": { torrent: { infoHash: "abc" } } });
    await expect(api.getTorrent("abc")).resolves.toEqual({ infoHash: "abc" });
  });

  it("uploads .torrent files as raw bytes", async () => {
    const fetchMock = mockFetch().mockResolvedValue(
      jsonResponse({ torrent: { infoHash: "x" } }, 201),
    );
    const file = new Blob(["d8:announce"]);

    await api.addTorrentFile(file);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/v1/torrents/file`);
    expect(init?.body).toBe(file);
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/x-bittorrent",
    );
  });

  it("removes a torrent's data, or forgets it too", async () => {
    const engine = mockEngine({
      "DELETE /v1/torrents/abc": noContent,
    });

    await api.removeTorrent("abc");
    await api.removeTorrent("abc", { forget: true });

    expect(engine.calls.map((call) => call.path)).toEqual([
      "/v1/torrents/abc",
      "/v1/torrents/abc?forget=true",
    ]);
  });

  it("answers null for a torrent the library doesn't know", async () => {
    mockEngine({
      "GET /v1/library/abc": engineError(404, "NOT_FOUND", "Not in library"),
    });
    await expect(api.getLibraryTorrent("abc")).resolves.toBeNull();
  });

  it("removes one file from Continue watching", async () => {
    const engine = mockEngine({
      "DELETE /v1/library/abc/files/3": noContent,
    });

    await api.removeProgress("abc", 3);

    expect(engine.callsTo("DELETE /v1/library/abc/files/3")).toHaveLength(1);
  });

  it("deletes playbacks with keepalive and never throws", async () => {
    const fetchMock = mockFetch().mockRejectedValue(new TypeError("offline"));

    await expect(api.deletePlayback("abc")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/v1/playback/abc`, {
      method: "DELETE",
      keepalive: true,
    });
  });

  it("asks for embedded cues in a time window", async () => {
    const fetchMock = mockFetch().mockResolvedValue(
      jsonResponse({ cues: [], coveredFrom: 0, coveredTo: 10 }),
    );

    await api.getPlaybackSubtitles("abc", 2, 55.123, 120);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${BASE}/v1/playback/abc/subtitles/2?from=55.1&to=120.0`,
    );
  });

  it("builds stream URLs under the engine base", () => {
    expect(api.streamUrl("abc", 3)).toBe(
      `${BASE}/v1/torrents/abc/files/3/stream`,
    );
  });
});

describe("errorMessage", () => {
  const quiet = () =>
    vi.spyOn(console, "warn").mockImplementation(() => {
      // The details go to the console; not worth printing in tests.
    });

  it("never shows route names or other developer text", () => {
    const warn = quiet();
    const missing = new ApiRequestError(
      404,
      "NOT_FOUND",
      "Route GET /v1/library not found",
    );

    expect(errorMessage(missing)).toBe(
      "Something went wrong. Please try again.",
    );
    expect(
      errorMessage(
        new ApiRequestError(400, "BAD_REQUEST", "Invalid JSON body"),
      ),
    ).toBe("Something went wrong. Please try again.");
    // The details are kept for whoever opens the console, once.
    errorMessage(missing);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.any(String), missing);
  });

  it("never shows system errors that slipped through", () => {
    quiet();
    expect(
      errorMessage(
        new ApiRequestError(
          503,
          "SERVICE_UNAVAILABLE",
          "ENOSPC: no space left on device, write '/Users/ann/x.mkv'",
        ),
      ),
    ).toBe("Something went wrong. Please try again.");
    expect(
      errorMessage(
        new ApiRequestError(
          400,
          "VALIDATION_FAILED",
          "Some fields are invalid",
          [{ path: "body.magnet", message: "x.trim is not a function" }],
        ),
      ),
    ).toBe("Some fields are invalid");
  });

  it("hides what crashed inside the engine", () => {
    quiet();
    expect(
      errorMessage(new ApiRequestError(500, "INTERNAL", "SQLITE_BUSY: locked")),
    ).toBe("The playback engine ran into a problem. Please try again.");
  });

  it("keeps the engine's messages written for people", () => {
    expect(
      errorMessage(
        new ApiRequestError(
          409,
          "CONFLICT",
          "The torrent's file list isn't known yet. Try again in a moment.",
        ),
      ),
    ).toBe("The torrent's file list isn't known yet. Try again in a moment.");
    expect(
      errorMessage(
        new ApiRequestError(400, "BAD_REQUEST", "This file has no video"),
      ),
    ).toBe("This file has no video");
  });

  it("turns bugs and anything else into a plain sentence", () => {
    quiet();
    expect(errorMessage(new TypeError("x is undefined"))).toBe(
      "Something went wrong. Please try again.",
    );
    expect(errorMessage("nope")).toBe(
      "Something went wrong. Please try again.",
    );
  });
});
