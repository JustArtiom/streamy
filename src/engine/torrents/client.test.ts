import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getRuntime } from "../config";
import { useTestRuntime } from "../test/runtime";
import {
  applyClientConfig,
  areDownloadsPaused,
  destroyTorrentClient,
  getTorrentClient,
  peekTorrentClient,
  resetTorrentClientForTests,
  setDownloadsPaused,
  setTorrentClientOptionsForTests,
} from "./client";

// A real WebTorrent client, kept off the internet: no DHT, trackers, LSD
// or port mapping. It only opens a local listening port.
describe("the torrent client", () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ cleanup } = await useTestRuntime());
    setTorrentClientOptionsForTests({
      dht: false,
      tracker: false,
      lsd: false,
      natUpnp: false,
      natPmp: false,
    });
  });

  afterAll(async () => {
    await destroyTorrentClient();
    resetTorrentClientForTests();
    await cleanup();
  });

  it("isn't created until something needs it (nothing connects at launch)", () => {
    expect(peekTorrentClient()).toBeNull();
    applyClientConfig(getRuntime().config); // no client: nothing to do
    expect(peekTorrentClient()).toBeNull();
  });

  it("is created once, with the settings' connection cap", () => {
    const client = getTorrentClient();
    expect(getTorrentClient()).toBe(client);
    expect(peekTorrentClient()).toBe(client);
    expect(client.maxConns).toBe(100);
  });

  it("applies new limits to the running client", () => {
    const client = getTorrentClient();
    const down = vi.spyOn(client, "throttleDownload");
    const up = vi.spyOn(client, "throttleUpload");

    applyClientConfig({
      ...getRuntime().config,
      downloadLimit: 500_000,
      uploadLimit: null,
      maxConnections: 20,
    });

    expect(down).toHaveBeenCalledWith(500_000);
    expect(up).toHaveBeenCalledWith(-1);
    expect(client.maxConns).toBe(20);
  });

  it("has uTP off (PLAN §4.4: TCP-only peers would take ~40 s)", () => {
    const client = getTorrentClient() as unknown as { utp: boolean };
    expect(client.utp).toBe(false);
  });

  it("holds every download at 0 while paused, through settings changes", () => {
    const client = getTorrentClient();
    const down = vi.spyOn(client, "throttleDownload");
    const config = { ...getRuntime().config, downloadLimit: 500_000 };

    setDownloadsPaused(true);
    expect(areDownloadsPaused()).toBe(true);
    expect(down).toHaveBeenLastCalledWith(0);
    applyClientConfig(config);
    expect(down).toHaveBeenLastCalledWith(0);

    // Back to the user's limit.
    setDownloadsPaused(false);
    expect(down).toHaveBeenLastCalledWith(-1);
    applyClientConfig(config);
    expect(down).toHaveBeenLastCalledWith(500_000);
  });

  it("refuses to start again once destroyed (shutdown)", async () => {
    getTorrentClient();
    await destroyTorrentClient();
    await destroyTorrentClient(); // twice is fine
    expect(() => getTorrentClient()).toThrow("shutting down");
  });
});
