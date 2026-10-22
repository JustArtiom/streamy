import { describe, expect, it } from "vitest";
import { api, isApiError } from "@/lib/api";
import { mockEngine, takeUnansweredEngineCalls } from "@/test/engine";
import { HASH } from "@/test/fixtures";

// The fake engine the UI tests use. A route a test forgot must not get a
// made-up answer: a 404 from /v1/torrents/… means "open it again" to the
// UI, so it would quietly change what the test checks.

describe("mockEngine", () => {
  it("fails the test on a route it wasn't given", async () => {
    mockEngine();

    const error: unknown = await api.getTorrent(HASH).catch((e: unknown) => e);

    // The page sees a failed request, never a 404…
    expect(isApiError(error, 404)).toBe(false);
    expect(error).toMatchObject({ status: 0, code: "NETWORK" });
    // …and setup.ts fails the test with the route. (Taken here, so this
    // test itself passes.)
    expect(takeUnansweredEngineCalls()).toEqual([`GET /v1/torrents/${HASH}`]);
  });

  it("answers the background requests like a healthy, empty engine", async () => {
    mockEngine();

    await expect(api.getHealth()).resolves.toMatchObject({
      lowDiskSpace: false,
    });
    await expect(api.getLibrary()).resolves.toEqual({
      continueWatching: [],
      recent: [],
    });
    await expect(api.getLibraryTorrent(HASH)).resolves.toBeNull();
    await expect(api.deletePlayer("player-1")).resolves.toBeUndefined();
    expect(takeUnansweredEngineCalls()).toEqual([]);
  });

  it("lets a test's own answer win", async () => {
    mockEngine({ "GET /v1/library": { continueWatching: [], recent: [1] } });

    await expect(api.getLibrary()).resolves.toEqual({
      continueWatching: [],
      recent: [1],
    });
  });
});
