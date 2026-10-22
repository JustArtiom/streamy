import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent, { type Torrent } from "webtorrent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ClientCapabilities,
  CreatePlaybackRequest,
  Library,
  MediaInfo,
  Playback,
  PlaybackStatus,
  TorrentDetail,
} from "../shared/engine-api";
import {
  ENGINE_SECRET_HEADER,
  type EngineInitMessage,
  type EngineToMainMessage,
} from "../shared/engine-protocol";
import { readTorrentRecord, torrentDataDir, writeTorrentRecord } from "./cache";
import { type RunningEngine, startEngine } from "./engine";
import { runningChildCount } from "./media/children";
import { type PlaybackHeartbeatEvent, playbackService } from "./media/playback";
import {
  findFfmpeg,
  makeVideoFolder,
  TEST_SECRET,
  testInitMessage,
} from "./test/runtime";
import { engineServices } from "./services";
import {
  getTorrentClient,
  resetTorrentClientForTests,
  setTorrentClientOptionsForTests,
} from "./torrents/client";
import { type TorrentMetadataEvent, torrentService } from "./torrents/service";

/*
 * End to end, in plain Node: the real engine (HTTP, WebTorrent, ffmpeg)
 * downloads generated videos from a local seeder and plays them every way.
 * Then it quits, the seeder goes away, and a new engine on the same folders
 * remembers what was watched and plays it again from the disk alone.
 *
 * Opt-in (it takes ~30 s):  STREAMY_E2E=1 npx vitest run src/engine/e2e.test.ts
 *
 * No internet: both clients have DHT, trackers, LSD and port mapping off,
 * and the magnet names the seeder directly (x.pe=127.0.0.1:<port>).
 */

const ffmpeg = findFfmpeg();
const enabled = process.env.STREAMY_E2E === "1" && ffmpeg !== null;

const OFFLINE = {
  dht: false,
  tracker: false,
  lsd: false,
  utPex: false,
  natUpnp: false,
  natPmp: false,
  webSeeds: false,
} as const;

const CHROME: ClientCapabilities = {
  video: {
    h264: true,
    h264High10: false,
    hevc: false,
    hevcMain10: false,
    av1: true,
    vp9: true,
  },
  audio: {
    aac: true,
    mp3: true,
    opus: true,
    flac: true,
    ac3: false,
    eac3: false,
  },
  direct: { mp4: true, webm: true },
};

function srt(word: string, seconds: number) {
  const time = (s: number) =>
    `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0").replace(".", ",")}`;
  return Array.from({ length: Math.floor(seconds / 4) }, (_, i) => {
    const start = i * 4 + 0.5;
    return `${i + 1}\n${time(start)} --> ${time(start + 2)}\n${word} ${i}\n`;
  }).join("\n");
}

/** A 90 s H.264+AAC MP4, and an MKV with two audio tracks and two subtitles. */
async function makeFixtures(dir: string, ffmpegPath: string) {
  await mkdir(dir, { recursive: true });
  const run = (args: string[]) =>
    execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...args,
    ]);
  // prettier-ignore
  run([
    "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=90",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=90",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-g", "48",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
    "-movflags", "+faststart",
    join(dir, "Clip.mp4"),
  ]);
  await writeFile(join(dir, "eng.srt"), srt("Hello", 90));
  await writeFile(join(dir, "spa.srt"), srt("Hola", 90));
  // prettier-ignore
  run([
    "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=90",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=90",
    "-f", "lavfi", "-i", "sine=frequency=660:duration=90",
    "-i", join(dir, "eng.srt"),
    "-i", join(dir, "spa.srt"),
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map", "4:s",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-g", "240",
    "-pix_fmt", "yuv420p",
    "-c:a:0", "aac", "-c:a:1", "ac3", "-c:s", "srt",
    "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=rus",
    "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=spa",
    join(dir, "Dub.mkv"),
  ]);
  await rm(join(dir, "spa.srt"));
  // An external subtitle next to the MP4.
  await writeFile(join(dir, "Clip.en.srt"), srt("External", 90));
  await rm(join(dir, "eng.srt"));
}

describe.runIf(enabled)(
  "the engine, end to end (local seeder)",
  { timeout: 60_000 },
  () => {
    let base: string;
    let init: EngineInitMessage;
    let seeder: WebTorrent | null = null;
    let seeded: Torrent;
    let engine: RunningEngine;
    let api: string;
    const posted: EngineToMainMessage[] = [];
    const metadata: TorrentMetadataEvent[] = [];
    const heartbeats: PlaybackHeartbeatEvent[] = [];
    let files: TorrentDetail["files"] = [];

    const headers = { [ENGINE_SECRET_HEADER]: TEST_SECRET };
    async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
      const res = await fetch(`${api}${path}`, {
        ...init,
        headers: {
          ...headers,
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      const body = (await res.json()) as T;
      if (!res.ok)
        throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
      return body;
    }
    function indexOf(name: string): number {
      const file = files.find((f) => f.name === name);
      if (!file) throw new Error(`No ${name}`);
      return file.index;
    }
    function playbackRequest(
      overrides: Partial<CreatePlaybackRequest>,
    ): CreatePlaybackRequest {
      return {
        infoHash: seeded.infoHash,
        fileIndex: 0,
        start: 0,
        audioTrack: null,
        quality: "original",
        burnSubtitle: null,
        embeddedSubtitles: false,
        forceMode: null,
        replaces: null,
        playerId: "e2e-player",
        capabilities: CHROME,
        ...overrides,
      };
    }

    beforeAll(async () => {
      base = await mkdtemp(join(tmpdir(), "streamy-e2e-"));
      const fixture = join(base, "seed", "Fixture");
      await makeFixtures(fixture, ffmpeg?.ffmpeg ?? "ffmpeg");

      // Speaks uTP like most real peers; the engine has uTP off (PLAN §4.4),
      // so it connects over TCP, which the seeder takes too.
      const seeding = new WebTorrent({ ...OFFLINE, utp: true });
      seeder = seeding;
      seeded = await new Promise<Torrent>((resolve) => {
        seeding.seed(fixture, { announce: [] }, resolve);
      });
      await vi.waitFor(() => {
        expect(seeding.torrentPort).toBeGreaterThan(0);
      });

      setTorrentClientOptionsForTests(OFFLINE);
      init = testInitMessage(base);
      await makeVideoFolder(init.config.cacheDir);
      engine = await startEngine(
        init,
        { post: (message) => posted.push(message) },
        // Like test mode: the seeder is on 127.0.0.1.
        { tuning: { trackers: [], allowLocalAddresses: true } },
      );
      api = `http://127.0.0.1:${engine.port}`;
      torrentService.onMetadata((event) => metadata.push(event));
      playbackService.onHeartbeat((event) => heartbeats.push(event));
    }, 120_000);

    async function stopSeeder() {
      const seeding = seeder;
      seeder = null;
      if (!seeding) return;
      await new Promise<void>((resolve) => {
        seeding.destroy(() => {
          resolve();
        });
      });
    }

    function seederPort(): number {
      if (!seeder) throw new Error("The seeder is gone");
      return seeder.torrentPort;
    }

    async function waitForTorrent(
      check: (torrent: TorrentDetail) => void,
      timeout = 30_000,
    ): Promise<TorrentDetail> {
      return vi.waitFor(
        async () => {
          const { torrent } = await json<{ torrent: TorrentDetail }>(
            `/v1/torrents/${seeded.infoHash}`,
          );
          check(torrent);
          return torrent;
        },
        { timeout, interval: 100 },
      );
    }

    afterAll(async () => {
      await engine.shutdown();
      resetTorrentClientForTests();
      await stopSeeder();
      await rm(base, { recursive: true, force: true });
    });

    it("adds the magnet and gets the file list from the seeder", async () => {
      const magnet = `magnet:?xt=urn:btih:${seeded.infoHash}&dn=Fixture&x.pe=127.0.0.1:${seederPort()}`;
      const added = await json<{ torrent: TorrentDetail }>("/v1/torrents", {
        method: "POST",
        body: JSON.stringify({ magnet }),
      });
      expect(added.torrent.status).toBe("fetching_metadata");

      const ready = await vi.waitFor(
        async () => {
          const { torrent } = await json<{ torrent: TorrentDetail }>(
            `/v1/torrents/${seeded.infoHash}`,
          );
          expect(torrent.status).toBe("ready");
          return torrent;
        },
        { timeout: 30_000, interval: 200 },
      );
      files = ready.files;
      expect(files.map((f) => f.name).sort()).toEqual([
        "Clip.en.srt",
        "Clip.mp4",
        "Dub.mkv",
      ]);
      expect(ready.peers).toBeGreaterThan(0);
      expect(metadata).toEqual([
        expect.objectContaining({
          infoHash: seeded.infoHash,
          name: "Fixture",
          magnet,
          fileCount: 3,
        }),
      ]);
    });

    it("streams a byte range of the MP4, exactly", async () => {
      const original = await readFile(
        join(base, "seed", "Fixture", "Clip.mp4"),
      );
      const index = indexOf("Clip.mp4");
      const res = await fetch(
        `${api}/v1/torrents/${seeded.infoHash}/files/${index}/stream`,
        { headers: { ...headers, Range: "bytes=100000-199999" } },
      );

      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(
        `bytes 100000-199999/${original.length}`,
      );
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(original.subarray(100000, 200000))).toBe(true);
    });

    it("probes both videos (through ffmpeg's token URLs)", async () => {
      const mp4 = await json<{ media: MediaInfo }>(
        `/v1/torrents/${seeded.infoHash}/files/${indexOf("Clip.mp4")}/media`,
      );
      expect(mp4.media).toMatchObject({
        duration: expect.closeTo(90, 0) as number,
        video: { codec: "h264", width: 640, height: 360 },
        audioTracks: [{ codec: "aac" }],
        subtitleTracks: [{ source: "file", language: "en" }],
      });

      const mkv = await json<{ media: MediaInfo }>(
        `/v1/torrents/${seeded.infoHash}/files/${indexOf("Dub.mkv")}/media`,
      );
      expect(mkv.media.audioTracks.map((t) => [t.codec, t.language])).toEqual([
        ["aac", "en"],
        ["ac3", "ru"],
      ]);
      // Clip.en.srt goes with Clip.mp4 (two videos: matched by name).
      expect(mkv.media.subtitleTracks.map((t) => t.id)).toEqual([
        "embedded:0",
        "embedded:1",
      ]);
    });

    it("plays the MP4 directly, with heartbeats saving the position past 30 s", async () => {
      const { playback } = await json<{ playback: Playback }>("/v1/playback", {
        method: "POST",
        body: JSON.stringify(
          playbackRequest({ fileIndex: indexOf("Clip.mp4") }),
        ),
      });
      expect(playback.mode).toBe("direct");
      expect(playback.url).toBe(
        `/v1/torrents/${seeded.infoHash}/files/${indexOf("Clip.mp4")}/stream`,
      );

      for (const position of [12, 35, 47]) {
        const { status } = await json<{ status: PlaybackStatus }>(
          `/v1/playback/${playback.id}/heartbeat`,
          {
            method: "POST",
            body: JSON.stringify({ position, paused: false, subtitle: null }),
          },
        );
        expect(status.state).toBe("running");
      }
      expect(heartbeats.at(-1)).toMatchObject({
        infoHash: seeded.infoHash,
        fileName: "Clip.mp4",
        position: 47,
        subtitle: null,
      });

      // The thumbnail is made in the background (ffmpeg, token URL).
      await engineServices()?.thumbnails.idle();
      const library = engineServices()?.library;
      const thumbnail = library?.thumbnailPath(
        seeded.infoHash,
        indexOf("Clip.mp4"),
      );
      expect(thumbnail && existsSync(thumbnail)).toBe(true);
      await fetch(`${api}/v1/playback/${playback.id}`, {
        method: "DELETE",
        headers,
      });
    });

    it.each([
      ["remux", { audioTrack: 1, start: 30 }],
      ["transcode", { forceMode: "transcode" as const, start: 30 }],
    ])(
      "plays the MKV as %s over HLS",
      { timeout: 60_000 },
      async (mode, overrides) => {
        const { playback } = await json<{ playback: Playback }>(
          "/v1/playback",
          {
            method: "POST",
            body: JSON.stringify(
              playbackRequest({ fileIndex: indexOf("Dub.mkv"), ...overrides }),
            ),
          },
        );
        expect(playback.mode).toBe(mode);
        expect(playback.offset).toBeGreaterThan(19);
        expect(playback.offset).toBeLessThanOrEqual(30);

        const playlist = await (
          await fetch(`${api}${playback.url}`, { headers })
        ).text();
        expect(playlist).toContain("#EXTINF");
        expect(playlist).toContain("seg_00000.m4s");
        const dir = playback.url.replace(/index\.m3u8$/, "");
        for (const file of ["init.mp4", "seg_00000.m4s"]) {
          const res = await fetch(`${api}${dir}${file}`, { headers });
          expect(res.status).toBe(200);
          expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(500);
        }

        const { status } = await json<{ status: PlaybackStatus }>(
          `/v1/playback/${playback.id}/heartbeat`,
          {
            method: "POST",
            body: JSON.stringify({ position: 31, paused: false }),
          },
        );
        expect(["running", "throttled", "finished"]).toContain(status.state);
        expect(status.producedUntil).toBeGreaterThan(playback.offset);

        const del = await fetch(`${api}/v1/playback/${playback.id}`, {
          method: "DELETE",
          headers,
        });
        expect(del.status).toBe(204);
      },
    );

    it("reported every ffmpeg/ffprobe to main, and none is left", async () => {
      await vi.waitFor(() => {
        expect(runningChildCount()).toBe(0);
      });
      const children = posted.filter((m) => m.type === "child");
      const alive = children.filter((m) => m.alive).length;
      expect(alive).toBeGreaterThan(3);
      expect(children.filter((m) => !m.alive)).toHaveLength(alive);
    });

    it("stopping keeps the data: re-adding finds it on disk", async () => {
      const dir = join(base, "cache", "torrents", seeded.infoHash);
      const before = await json<{ torrent: TorrentDetail }>(
        `/v1/torrents/${seeded.infoHash}`,
      );
      expect(before.torrent.progress).toBeGreaterThan(0);

      await torrentService.stop(seeded.infoHash);
      expect(existsSync(dir)).toBe(true);
      const stopped = await fetch(`${api}/v1/torrents/${seeded.infoHash}`, {
        headers,
      });
      expect(stopped.status).toBe(404);

      // Re-open it (the library has the metadata, the data is local).
      await json("/v1/torrents", {
        method: "POST",
        body: JSON.stringify({
          magnet: `magnet:?xt=urn:btih:${seeded.infoHash}&x.pe=127.0.0.1:${seederPort()}`,
        }),
      });
      const again = await waitForTorrent((torrent) => {
        expect(torrent.status).toBe("ready");
      });
      expect(again.progress).toBeGreaterThan(0);
    });

    it("downloads every file whole", async () => {
      for (const file of files) {
        const res = await fetch(
          `${api}/v1/torrents/${seeded.infoHash}/files/${file.index}/stream`,
          { headers },
        );
        expect((await res.arrayBuffer()).byteLength).toBe(file.size);
      }
      await waitForTorrent((torrent) => {
        expect(torrent.progress).toBe(1);
      });
    });

    it("quits, saving the resume record; a new engine starts with the seeder gone", async () => {
      await engine.shutdown();
      const record = await readTorrentRecord(
        init.config.cacheDir,
        seeded.infoHash,
      );
      expect(record?.name).toBe("Fixture");
      expect(
        record?.bitfield?.every((byte, i, all) =>
          // Every piece, except the unused bits after the last one.
          i < all.length - 1 ? byte === 0xff : byte !== 0,
        ),
      ).toBe(true);

      await stopSeeder();
      resetTorrentClientForTests();
      setTorrentClientOptionsForTests(OFFLINE);
      engine = await startEngine(
        init,
        { post: (message) => posted.push(message) },
        // Like test mode: the seeder is on 127.0.0.1.
        { tuning: { trackers: [], allowLocalAddresses: true } },
      );
      api = `http://127.0.0.1:${engine.port}`;
      const gone = await fetch(`${api}/v1/torrents/${seeded.infoHash}`, {
        headers,
      });
      expect(gone.status).toBe(404); // nothing connects at launch
    });

    it("remembers: Continue watching shows the clip, with its thumbnail", async () => {
      const library = await json<Library>("/v1/library");

      expect(library.recent).toEqual([
        expect.objectContaining({
          infoHash: seeded.infoHash,
          name: "Fixture",
          active: false,
        }),
      ]);
      // Newest first: the MKV's HLS heartbeats (31 s) came after the MP4's.
      expect(library.continueWatching).toEqual([
        expect.objectContaining({
          fileName: "Dub.mkv",
          position: 31,
          thumbnailUrl: `/v1/library/${seeded.infoHash}/files/${indexOf("Dub.mkv")}/thumbnail`,
        }),
        expect.objectContaining({
          infoHash: seeded.infoHash,
          fileName: "Clip.mp4",
          torrentName: "Fixture",
          position: 47,
          duration: expect.closeTo(90, 0) as number,
          thumbnailUrl: `/v1/library/${seeded.infoHash}/files/${indexOf("Clip.mp4")}/thumbnail`,
        }),
      ]);
      const thumbnail = await fetch(
        `${api}${library.continueWatching[1]?.thumbnailUrl ?? ""}`,
        { headers },
      );
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
      expect((await thumbnail.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    });

    it("re-opens it from the saved metadata at once, complete, without hashing every piece", async () => {
      let verified = 0;
      getTorrentClient().on("add", (torrent: Torrent) => {
        torrent.on("verified", () => {
          verified += 1;
        });
      });
      const started = Date.now();

      const added = await json<{ torrent: TorrentDetail }>("/v1/torrents", {
        method: "POST",
        body: JSON.stringify({ magnet: seeded.infoHash }),
      });
      expect(added.torrent.infoHash).toBe(seeded.infoHash);
      const ready = await waitForTorrent((torrent) => {
        expect(torrent.status).toBe("ready");
      }, 5_000);

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(ready.progress).toBe(1);
      expect(ready.peers).toBe(0);
      expect(ready.files.map((f) => f.progress)).toEqual([1, 1, 1]);
      // One spot check per file at most, not every piece.
      expect(verified).toBeLessThanOrEqual(files.length);
      const pieces = Math.ceil(seeded.length / seeded.pieceLength);
      expect(pieces).toBeGreaterThan(files.length * 4);
    });

    it("streams bytes with no peers at all", async () => {
      const original = await readFile(
        join(base, "seed", "Fixture", "Clip.mp4"),
      );
      const index = indexOf("Clip.mp4");
      const res = await fetch(
        `${api}/v1/torrents/${seeded.infoHash}/files/${index}/stream`,
        { headers: { ...headers, Range: "bytes=300000-399999" } },
      );
      expect(res.status).toBe(206);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(original.subarray(300000, 400000))).toBe(true);
    });

    it("a 1-byte limit deletes a stored torrent, never the active one", async () => {
      const { cacheDir } = init.config;
      const stored = "e".repeat(40);
      await mkdir(torrentDataDir(cacheDir, stored), { recursive: true });
      await writeFile(join(torrentDataDir(cacheDir, stored), "old.mkv"), "x");
      await writeTorrentRecord(cacheDir, stored, {
        name: "Old",
        addedAt: 0,
        lastUsedAt: 0,
        bitfield: null,
      });

      engine.applyConfig({ ...init.config, cacheLimitBytes: 1 });

      await vi.waitFor(() => {
        expect(existsSync(torrentDataDir(cacheDir, stored))).toBe(false);
      });
      expect(existsSync(torrentDataDir(cacheDir, seeded.infoHash))).toBe(true);
      const active = await json<{ torrent: TorrentDetail }>(
        `/v1/torrents/${seeded.infoHash}`,
      );
      expect(active.torrent.progress).toBe(1);
      engine.applyConfig(init.config);
    });

    it("clearing the videos stops the torrent and keeps the library", async () => {
      const res = await fetch(`${api}/v1/cache/clear`, {
        method: "POST",
        headers,
      });

      expect(res.status).toBe(204);
      expect(readdirSync(join(init.config.cacheDir, "torrents"))).toEqual([]);
      const gone = await fetch(`${api}/v1/torrents/${seeded.infoHash}`, {
        headers,
      });
      expect(gone.status).toBe(404);
      const library = await json<Library>("/v1/library");
      expect(library.recent).toHaveLength(1);
      expect(library.continueWatching.map((item) => item.position)).toEqual([
        31, 47,
      ]);
    });

    it("forgets the torrent: deleted, and gone from the library", async () => {
      await json("/v1/torrents", {
        method: "POST",
        body: JSON.stringify({ magnet: seeded.infoHash }),
      });
      const dir = torrentDataDir(init.config.cacheDir, seeded.infoHash);

      const res = await fetch(
        `${api}/v1/torrents/${seeded.infoHash}?forget=true`,
        { method: "DELETE", headers },
      );

      expect(res.status).toBe(204);
      expect(existsSync(dir)).toBe(false);
      const gone = await fetch(`${api}/v1/torrents/${seeded.infoHash}`, {
        headers,
      });
      expect(gone.status).toBe(404);
      expect(await json<Library>("/v1/library")).toEqual({
        continueWatching: [],
        recent: [],
      });
    });
  },
);
