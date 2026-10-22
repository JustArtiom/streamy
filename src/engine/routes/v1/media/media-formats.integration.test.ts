import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ClientCapabilities,
  CreatePlaybackRequest,
  PlaybackStatus,
} from "../../../../shared/engine-api";
import { cachePaths, getRuntime, updateTuning } from "../../../config";
import { errorHandler } from "../../../http/error-handler";
import { hasFilter } from "../../../media/encoders";
import { videoFilterChain } from "../../../media/ffmpeg-args";
import { playbackService } from "../../../media/playback";
import { firstDecodeTime } from "../../../media/probe";
import {
  type FakeFile,
  fakeTorrents,
  makeMedia,
  pgsSubtitles,
} from "../../../media/test-media";
import { findFfmpeg, useTestRuntime } from "../../../test/runtime";
import {
  revokeAllFileTokens,
  setInternalOrigin,
} from "../../../torrents/file-tokens";
import * as internalFilesGet from "../../internal/files.get";
import { mediaRouter } from "./router";

/*
 * Real ffmpeg on generated files that used to go wrong: a file already on
 * disk (throttling), AAC in .ts, a TS recording starting at 1001 s, a 1080p
 * picture subtitle on 720p video, HDR without colour tags, a "movie" that's
 * really a DASH manifest, a proxy in the environment, a read that dies.
 */

vi.mock("../../../torrents/service", async () => {
  const { fakeTorrents } = await import("../../../media/test-media");
  return { torrentService: fakeTorrents.service };
});

const binaries = findFfmpeg();
const FFMPEG = binaries?.ffmpeg ?? "ffmpeg";
const FFPROBE = binaries?.ffprobe ?? "ffprobe";

const CAPS: ClientCapabilities = {
  video: {
    h264: true,
    h264High10: false,
    hevc: false,
    hevcMain10: false,
    av1: false,
    vp9: false,
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

const LOCAL = "1".repeat(40);
const ADTS = "2".repeat(40);
const OFFSET = "3".repeat(40);
const PGS = "4".repeat(40);
const DASH = "5".repeat(40);
const CUT_GONE = "6".repeat(40);
const CUT_OK = "7".repeat(40);
const PROXIED = "8".repeat(40);

let players = 0;
function playbackRequest(
  overrides: Partial<CreatePlaybackRequest>,
): CreatePlaybackRequest {
  players += 1;
  return {
    infoHash: LOCAL,
    fileIndex: 0,
    start: 0,
    audioTrack: null,
    quality: "original",
    burnSubtitle: null,
    embeddedSubtitles: false,
    forceMode: null,
    replaces: null,
    playerId: `formats-${players}`,
    capabilities: CAPS,
    ...overrides,
  };
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await sleep(100);
  }
}

/** A server that records every request (a LAN device, or a proxy). */
async function recorder(): Promise<{
  url: string;
  hits: string[];
  server: Server;
}> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method ?? "?"} ${req.url ?? ""}`);
    res.statusCode = 502;
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits, server };
}

function hasEncoder(name: string): boolean {
  return execFileSync(FFMPEG, ["-hide_banner", "-encoders"])
    .toString()
    .includes(` ${name} `);
}

describe.skipIf(!binaries)("media formats with real ffmpeg", () => {
  let workDir: string;
  let internalServer: Server;
  let app: express.Express;
  let victim: Awaited<ReturnType<typeof recorder>>;
  /** Files whose session read will die after `cutAfter` bytes. */
  let cutGone: FakeFile;
  let cutOk: FakeFile;
  let cutAfter: number;
  let cleanupRuntime: () => Promise<void>;

  const create = (overrides: Partial<CreatePlaybackRequest>) =>
    request(app).post("/v1/playback").send(playbackRequest(overrides));
  const beat = async (id: string, position: number) =>
    (
      await request(app)
        .post(`/v1/playback/${id}/heartbeat`)
        .send({ position, paused: false })
    ).body.status as PlaybackStatus;
  const playlistOf = (id: string) =>
    join(cachePaths().playback, id, "index.m3u8");

  beforeAll(async () => {
    ({ cleanup: cleanupRuntime } = await useTestRuntime());
    workDir = await mkdtemp(join(tmpdir(), "streamy-formats-"));
    victim = await recorder();
    const at = (name: string) => join(workDir, name);

    // ~3 Mbit/s, keyframe every 2 s: a real movie's density.
    // prettier-ignore
    makeMedia(FFMPEG, [
      "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=60,noise=alls=40:allf=t",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "3M", "-g", "48",
      "-pix_fmt", "yuv420p", "-c:a", "aac", at("local.mkv"),
    ]);
    // AAC in MPEG-TS has ADTS headers; and a TV recording starting at 1001 s.
    // prettier-ignore
    const tsArgs = [
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "25",
      "-pix_fmt", "yuv420p", "-c:a", "aac",
    ];
    makeMedia(FFMPEG, [...tsArgs, "-f", "mpegts", at("adts.ts")]);
    makeMedia(FFMPEG, [
      ...tsArgs,
      "-output_ts_offset",
      "1000",
      "-f",
      "mpegts",
      at("offset.ts"),
    ]);
    // A 1080p PGS track (white box low on its canvas) on 720p video.
    await writeFile(
      at("subs.sup"),
      pgsSubtitles(
        { width: 1920, height: 1080 },
        { x: 760, y: 950, width: 400, height: 60 },
        [1, 6],
      ),
    );
    // prettier-ignore
    makeMedia(FFMPEG, [
      "-f", "lavfi", "-i", "color=c=gray:s=1280x720:r=24:d=10",
      "-i", at("subs.sup"),
      "-map", "0:v", "-map", "1:s",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:s", "copy", at("pgs.mkv"),
    ]);
    // A "movie" (and a "subtitle file") that's really a DASH manifest.
    const mpd = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT10S" minBufferTime="PT1S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1000" width="640" height="360" codecs="avc1.42c01e"><BaseURL>${victim.url}/lan-device/admin.cgi?f=.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    await writeFile(at("dash.mkv"), mpd);
    await writeFile(at("dash.srt"), mpd);

    const one = (file: FakeFile): FakeFile[] => [file];
    fakeTorrents.add(LOCAL, one({ name: "Local.mkv", path: at("local.mkv") }));
    fakeTorrents.add(ADTS, one({ name: "Adts.ts", path: at("adts.ts") }));
    fakeTorrents.add(OFFSET, one({ name: "Rec.ts", path: at("offset.ts") }));
    fakeTorrents.add(PGS, one({ name: "Pgs.mkv", path: at("pgs.mkv") }));
    fakeTorrents.add(DASH, [
      { name: "Movie.mkv", path: at("dash.mkv") },
      { name: "Movie.srt", path: at("dash.srt") },
    ]);
    cutAfter = 0.4 * (await readFile(at("adts.ts"))).length;
    cutGone = { name: "Cut.ts", path: at("adts.ts") };
    cutOk = { name: "Cut.ts", path: at("adts.ts") };
    fakeTorrents.add(CUT_GONE, [cutGone]);
    fakeTorrents.add(CUT_OK, [cutOk]);
    fakeTorrents.add(PROXIED, one({ name: "P.ts", path: at("adts.ts") }));

    app = express();
    app.use(express.json());
    app.get("/internal/files/:token", internalFilesGet.handler);
    app.use("/v1", mediaRouter);
    app.use(errorHandler);
    internalServer = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => internalServer.once("listening", resolve));
    const { port } = internalServer.address() as AddressInfo;
    setInternalOrigin(`http://127.0.0.1:${port}`);
  }, 120_000);

  afterAll(async () => {
    await playbackService.shutdown();
    revokeAllFileTokens();
    setInternalOrigin(null);
    internalServer.closeAllConnections();
    internalServer.close();
    victim.server.close();
    await rm(workDir, { recursive: true, force: true });
    await cleanupRuntime();
  });

  it(
    "a file already on disk stays within the lead before and after heartbeats",
    { timeout: 60_000 },
    async () => {
      const ahead = getRuntime().tuning.transcodeAheadSeconds;
      updateTuning({ transcodeAheadSeconds: 12 });
      try {
        const res = await create({ infoHash: LOCAL });
        expect(res.status).toBe(201);
        const id: string = res.body.playback.id;

        // Unthrottled, ffmpeg copies the whole minute in well under a second.
        await sleep(2500);
        const first = await beat(id, 0);
        expect(first.state).toBe("throttled");
        expect(first.producedUntil).toBeGreaterThanOrEqual(8);
        expect(first.producedUntil).toBeLessThanOrEqual(24);
        expect(playbackService.pid(id)).not.toBeNull();

        // The viewer moved on: it goes on, and stops again 12 s past it.
        await beat(id, 20);
        await sleep(2500);
        const second = await beat(id, 20);
        expect(second.state).toBe("throttled");
        expect(second.producedUntil).toBeGreaterThan(first.producedUntil ?? 0);
        expect(second.producedUntil).toBeLessThanOrEqual(44);

        // Close to the end: it finishes.
        const end = await waitFor(async () => {
          const status = await beat(id, 55);
          return status.state === "finished" && status;
        });
        expect(end.producedUntil).toBeGreaterThan(59);
        await request(app).delete(`/v1/playback/${id}`);
      } finally {
        updateTuning({ transcodeAheadSeconds: ahead });
      }
    },
  );

  it(
    "remuxes AAC from .ts (ADTS) by copying it",
    { timeout: 30_000 },
    async () => {
      const res = await create({ infoHash: ADTS });
      expect(res.status).toBe(201);
      expect(res.body.playback).toMatchObject({
        mode: "remux",
        output: { audioCodec: "aac" },
      });
      const status = await waitFor(async () => {
        const status = await beat(res.body.playback.id, 0);
        return status.state !== "running" && status;
      });
      expect(status).toMatchObject({ state: "finished", error: null });
      expect(status.producedUntil).toBeGreaterThan(29);
      await request(app).delete(`/v1/playback/${res.body.playback.id}`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "a create fails (plainly) when ffmpeg dies right after its first segment",
    { timeout: 30_000 },
    async () => {
      // Writes one segment's worth of playlist, then fails like the old
      // ADTS case did (exit 255).
      const fake = join(workDir, "fake-ffmpeg.sh");
      await writeFile(
        fake,
        `#!/bin/sh\nprintf '#EXTM3U\\n#EXTINF:4.0,\\nseg_00000.m4s\\n' > index.m3u8\necho "[out#0/hls @ 0x1] Error muxing a packet" >&2\nexit 255\n`,
      );
      await chmod(fake, 0o755);
      const runtime = getRuntime();
      const real = runtime.ffmpegPath;
      runtime.ffmpegPath = fake;
      try {
        const res = await create({ infoHash: ADTS });
        expect(res.status).toBe(500);
        expect(res.body.error.message).toBe(
          "Streamy couldn't prepare this video for playing.",
        );
        expect(playbackService.count()).toBe(0);
      } finally {
        runtime.ffmpegPath = real;
      }
    },
  );

  describe(
    "a TS recording whose clock starts at 1001 s",
    { timeout: 30_000 },
    () => {
      it("has a movie timeline from 0", async () => {
        const media = await request(app).get(
          `/v1/torrents/${OFFSET}/files/0/media`,
        );
        expect(media.body.media.duration).toBeCloseTo(30, 0);

        const res = await create({ infoHash: OFFSET, start: 10 });
        expect(res.status).toBe(201);
        const { id, offset } = res.body.playback;
        expect(offset).toBeGreaterThan(8.5);
        expect(offset).toBeLessThanOrEqual(10.1);
        const status = await waitFor(async () => {
          const status = await beat(id, 10);
          return status.state === "finished" && status;
        });
        // Not 1031: the time can't go past the end.
        expect(status.producedUntil).toBeGreaterThan(29);
        expect(status.producedUntil).toBeLessThan(31.5);
        await request(app).delete(`/v1/playback/${id}`);
      });

      it("transcodes it with audio and video starting together", async () => {
        const res = await create({
          infoHash: OFFSET,
          start: 10,
          forceMode: "transcode",
        });
        expect(res.status).toBe(201);
        expect(res.body.playback.mode).toBe("transcode");
        const { id, offset } = res.body.playback;
        const [video, audio] = await Promise.all([
          firstDecodeTime(playlistOf(id), "v:0"),
          firstDecodeTime(playlistOf(id), "a:0"),
        ]);
        expect(video).toBeGreaterThan(8.5);
        expect(video).toBeLessThanOrEqual(10.1);
        expect(Math.abs((audio ?? 0) - (video ?? 0))).toBeLessThan(0.05);
        expect(offset).toBeCloseTo(Math.min(video ?? 0, audio ?? 0), 3);
        await request(app).delete(`/v1/playback/${id}`);
      });
    },
  );

  it(
    "burns a 1080p picture subtitle into 720p video where it belongs",
    { timeout: 60_000 },
    async () => {
      const res = await create({ infoHash: PGS, burnSubtitle: "embedded:0" });
      expect(res.status).toBe(201);
      const { id } = res.body.playback;
      await waitFor(async () => (await beat(id, 0)).state === "finished");

      // The box at (760, 950) on 1920×1080 is at (507, 633) on 1280×720.
      // prettier-ignore
      const { stderr: out } = spawnSync(FFMPEG, [
        "-hide_banner", "-loglevel", "info", "-live_start_index", "0",
        "-i", playlistOf(id),
        "-vf", "trim=start=2:end=2.1,crop=260:36:510:636,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
        "-f", "null", "-",
      ], { encoding: "utf8" });
      const brightness = Number(/YAVG=([\d.]+)/.exec(out)?.[1]);
      expect(brightness).toBeGreaterThan(200); // white, not the gray video
      await request(app).delete(`/v1/playback/${id}`);
    },
  );

  it("never fetches what a DASH manifest posing as a movie or subtitle names", async () => {
    const movie = await request(app).get(`/v1/torrents/${DASH}/files/0/media`);
    expect(movie.status).toBe(400);
    expect(movie.body.error.message).toBe("Couldn't read this file as a video");
    // Read as SRT (the extension says so): no cues in it, and nothing fetched.
    const subtitle = await request(app).get(
      `/v1/torrents/${DASH}/files/1/subtitles`,
    );
    expect(subtitle.body).toEqual({ cues: [] });
    expect(victim.hits).toEqual([]);
  });

  it("ignores proxy settings: token URLs stay on this computer", async () => {
    const proxy = await recorder();
    const names = ["http_proxy", "HTTP_PROXY", "ALL_PROXY", "FFREPORT"];
    const saved = names.map((name) => process.env[name]);
    for (const name of names.slice(0, 3)) process.env[name] = proxy.url;
    process.env.FFREPORT = `file=${join(workDir, "report.log")}`;
    try {
      const res = await request(app).get(
        `/v1/torrents/${PROXIED}/files/0/media`,
      );
      expect(res.status).toBe(200);
      expect(proxy.hits).toEqual([]);
    } finally {
      names.forEach((name, i) => {
        const value = saved[i];
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      });
      proxy.server.close();
    }
  });

  describe("a read that dies mid-file", { timeout: 60_000 }, () => {
    it("is an error when the data stays gone (not a finished movie)", async () => {
      // Probed first: the read that dies is the session's.
      await request(app).get(`/v1/torrents/${CUT_GONE}/files/0/media`);
      cutGone.cut = { after: cutAfter, then: "gone" };
      const res = await create({ infoHash: CUT_GONE });
      expect(res.status).toBe(201);
      const status = await waitFor(async () => {
        const status = await beat(res.body.playback.id, 0);
        return status.state !== "running" && status;
      });
      expect(status).toMatchObject({
        state: "error",
        error: "Streamy couldn't prepare the rest of this video.",
      });
      await request(app).delete(`/v1/playback/${res.body.playback.id}`);
    });

    it("reconnects and goes on when the data is still there", async () => {
      await request(app).get(`/v1/torrents/${CUT_OK}/files/0/media`);
      cutOk.cut = { after: cutAfter, then: "ok" };
      const res = await create({ infoHash: CUT_OK });
      expect(res.status).toBe(201);
      const status = await waitFor(async () => {
        const status = await beat(res.body.playback.id, 0);
        return status.state !== "running" && status;
      });
      expect(status.state).toBe("finished");
      expect(status.producedUntil).toBeGreaterThan(29);
      await request(app).delete(`/v1/playback/${res.body.playback.id}`);
    });
  });

  describe.runIf(binaries && hasEncoder("libx265"))(
    "HDR tone mapping, colour tags or not",
    () => {
      const samples = [
        ["untagged PQ", "transfer=smpte2084", "smpte2084"],
        [
          "tagged PQ",
          "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
          "smpte2084",
        ],
        ["untagged HLG", "transfer=arib-std-b67", "arib-std-b67"],
      ] as const;

      it.each(samples)("%s", { timeout: 60_000 }, (name, params, transfer) => {
        const file = join(workDir, `${name.replace(" ", "-")}.mkv`);
        // prettier-ignore
        makeMedia(FFMPEG, [
          "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=1",
          "-pix_fmt", "yuv420p10le", "-c:v", "libx265",
          "-x265-params", `log-level=error:${params}`, file,
        ]);
        expect(
          execFileSync(FFPROBE, [
            "-v",
            "error",
            "-show_entries",
            "stream=color_transfer",
            "-of",
            "csv=p=0",
            file,
          ])
            .toString()
            .trim(),
        ).toBe(transfer);

        const filters = execFileSync(FFMPEG, [
          "-hide_banner",
          "-filters",
        ]).toString();
        const mappers = (["tonemapx", "zscale"] as const).filter((mapper) =>
          hasFilter(filters, mapper),
        );
        expect(mappers.length).toBeGreaterThan(0);
        for (const toneMapper of mappers) {
          const chain = videoFilterChain({
            kind: "encode",
            encoder: "libx264",
            fps: 24,
            hdr: transfer,
            toneMapper,
            deinterlace: false,
            width: 640,
            height: 360,
            scaleToHeight: null,
            burnSubtitle: null,
          });
          // Throws (exit code ≠ 0) on "no path between colorspaces".
          // prettier-ignore
          execFileSync(FFMPEG, [
            "-hide_banner", "-loglevel", "error", "-i", file,
            "-vf", chain, "-c:v", "libx264", "-preset", "ultrafast",
            "-f", "null", "-",
          ]);
        }
      });
    },
  );
});
