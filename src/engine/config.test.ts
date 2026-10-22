import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cachePaths,
  DEFAULT_TUNING,
  getRuntime,
  initRuntime,
  parseMainMessage,
  resetRuntimeForTests,
  toWebTorrentRate,
  updateConfig,
  updateTuning,
} from "./config";
import { TEST_SECRET, testConfig, testInitMessage } from "./test/runtime";

const BASE = join("/", "tmp", "streamy-config-test");

afterEach(() => {
  resetRuntimeForTests();
});

describe("parseMainMessage", () => {
  it("accepts an init message", () => {
    const init = testInitMessage(BASE);
    expect(parseMainMessage(init)).toEqual({ ok: true, message: init });
  });

  it("drops fields it doesn't know (a newer main may send more)", () => {
    const init = testInitMessage(BASE);
    const result = parseMainMessage({ ...init, somethingNew: 1 });
    expect(result).toEqual({ ok: true, message: init });
  });

  it("accepts config and shutdown messages", () => {
    const config = testConfig(join(BASE, "other"));
    expect(parseMainMessage({ type: "config", config })).toEqual({
      ok: true,
      message: { type: "config", config },
    });
    expect(parseMainMessage({ type: "shutdown" })).toEqual({
      ok: true,
      message: { type: "shutdown" },
    });
  });

  it.each([
    ["a relative video folder", { cacheDir: "videos" }, "config.cacheDir"],
    [
      "a bad encoding mode",
      { hardwareEncoding: "gpu" },
      "config.hardwareEncoding",
    ],
    ["0 connections", { maxConnections: 0 }, "config.maxConnections"],
    ["a negative limit", { downloadLimit: -5 }, "config.downloadLimit"],
  ])("refuses %s, naming the field", (_name, patch, field) => {
    const init = testInitMessage(BASE);
    const result = parseMainMessage({
      ...init,
      config: { ...init.config, ...patch },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(field);
  });

  it("never puts the secret in its error", () => {
    const result = parseMainMessage({
      ...testInitMessage(BASE),
      logLevel: "loud",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("logLevel");
      expect(result.error).not.toContain(TEST_SECRET);
    }
  });

  it.each([
    ["a short secret", { secret: "abc" }],
    ["no secret", { secret: undefined }],
    ["an unknown type", { type: "reboot" }],
  ])("refuses %s", (_name, patch) => {
    expect(parseMainMessage({ ...testInitMessage(BASE), ...patch }).ok).toBe(
      false,
    );
  });

  it.each([null, "init", 42, []])("refuses %j", (data) => {
    expect(parseMainMessage(data).ok).toBe(false);
  });
});

describe("the runtime", () => {
  it("throws before init", () => {
    expect(() => getRuntime()).toThrow("isn't initialised");
  });

  it("starts from the init message and the default tuning", () => {
    const init = testInitMessage(BASE);
    const runtime = initRuntime(init);
    expect(runtime).toEqual({
      appVersion: "0.0.0-test",
      dataDir: init.dataDir,
      logsDir: init.logsDir,
      ffmpegPath: init.ffmpegPath,
      ffprobePath: init.ffprobePath,
      config: init.config,
      tuning: DEFAULT_TUNING,
    });
    // The prototype's defaults.
    expect(DEFAULT_TUNING).toMatchObject({
      hlsSegmentSeconds: 4,
      transcodeAheadSeconds: 240,
      maxTranscodes: 2,
      playbackIdleSeconds: 60,
      playbackStartTimeoutSeconds: 120,
      backgroundDownload: true,
    });
    expect(DEFAULT_TUNING.trackers.length).toBeGreaterThan(3);
  });

  it("replaces the config and returns the old one", () => {
    initRuntime(testInitMessage(BASE));
    const next = { ...testConfig(join(BASE, "new")), downloadLimit: 1000 };

    const previous = updateConfig(next);

    expect(previous.cacheDir).toBe(join(BASE, "cache"));
    expect(getRuntime().config).toEqual(next);
  });

  it("lets tests change the tuning", () => {
    initRuntime(testInitMessage(BASE), { maxTranscodes: 5 });
    updateTuning({ transcodeAheadSeconds: 8 });
    expect(getRuntime().tuning).toMatchObject({
      maxTranscodes: 5,
      transcodeAheadSeconds: 8,
    });
  });
});

describe("cachePaths", () => {
  it("puts the three folders inside the video folder", () => {
    expect(cachePaths(join(BASE, "v"))).toEqual({
      torrents: join(BASE, "v", "torrents"),
      playback: join(BASE, "v", "playback"),
      subtitles: join(BASE, "v", "subtitles"),
    });
  });
});

describe("toWebTorrentRate", () => {
  it("is bytes per second, -1 for unlimited (null or 0)", () => {
    expect(toWebTorrentRate(null)).toBe(-1);
    expect(toWebTorrentRate(0)).toBe(-1);
    expect(toWebTorrentRate(1024.4)).toBe(1024);
  });
});
