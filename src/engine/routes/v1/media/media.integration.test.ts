import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
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
  SubtitleCuesResponse,
} from "../../../../shared/engine-api";
import {
  cachePaths,
  getRuntime,
  updateConfig,
  updateTuning,
} from "../../../config";
import { errorHandler } from "../../../http/error-handler";
import { runningChildCount, setChildReporter } from "../../../media/children";
import {
  type PlaybackHeartbeatEvent,
  playbackService,
} from "../../../media/playback";
import { SERVER_CONTROL_TAG } from "../../../media/playlist";
import { firstDecodeTime, probeSessionOffset } from "../../../media/probe";
import {
  type FakeFile,
  fakeTorrents,
  makeMedia,
} from "../../../media/test-media";
import { type EngineServices, setEngineServices } from "../../../services";
import {
  findFfmpeg,
  makeVideoFolder,
  useTestRuntime,
} from "../../../test/runtime";
import {
  revokeAllFileTokens,
  setInternalOrigin,
} from "../../../torrents/file-tokens";
import * as internalFilesGet from "../../internal/files.get";
import { mediaRouter } from "./router";

/*
 * The media routes against REAL ffmpeg/ffprobe: a generated 60 s MKV
 * (H.264 GOP 10 s, AAC eng + AC3 rus, SRT eng + spa), read by ffmpeg
 * through the real /internal/files/<token> route from a fake torrent.
 */

vi.mock("../../../torrents/service", async () => {
  const { fakeTorrents } = await import("../../../media/test-media");
  return { torrentService: fakeTorrents.service };
});

const binaries = findFfmpeg();
const hasFfmpeg = binaries !== null;
const FFMPEG = binaries?.ffmpeg ?? "ffmpeg";

const HASH = "a".repeat(40);
const SLOW_HASH = "b".repeat(40);
/** Downloading: half of it so far. */
const PARTIAL_HASH = "d".repeat(40);

const CAPS: ClientCapabilities = {
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

let players = 0;

/** A request from a new player each time, unless `playerId` says otherwise. */
function playbackRequest(
  overrides: Partial<CreatePlaybackRequest> = {},
): CreatePlaybackRequest {
  players += 1;
  return {
    infoHash: HASH,
    fileIndex: 0,
    start: 0,
    audioTrack: null,
    quality: "original",
    burnSubtitle: null,
    embeddedSubtitles: false,
    forceMode: null,
    replaces: null,
    playerId: `player-${players}`,
    capabilities: CAPS,
    ...overrides,
  };
}

const RUSSIAN_SRT = `1
00:00:01,000 --> 00:00:03,500
Привет, как дела? Это проверка кодировки.

2
00:00:04,000 --> 00:00:06,000
{\\an8}<i>Ёжик в тумане</i> &amp; друзья
Вторая строка
`;

/** Text → Windows-1251 bytes (ASCII + Russian letters only). */
function cp1251(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code >= 0x410 && code <= 0x44f) bytes.push(code - 0x410 + 0xc0);
    else if (code === 0x401)
      bytes.push(0xa8); // Ё
    else if (code === 0x451)
      bytes.push(0xb8); // ё
    else throw new Error(`No cp1251 byte for ${char}`);
  }
  return Buffer.from(bytes);
}

function srt(word: string) {
  const time = (s: number) =>
    `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0").replace(".", ",")}`;
  return Array.from({ length: 30 }, (_, i) => {
    const start = i * 2 + 0.5;
    return `${i + 1}\n${time(start)} --> ${time(start + 1.5)}\n${word} <i>${i}</i> &amp; more\n`;
  }).join("\n");
}

/** The session folders (one per remux/transcode session). */
function playbackDir(): string {
  return cachePaths().playback;
}

function processState(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)])
      .toString()
      .trim();
  } catch {
    return null; // No such process.
  }
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await sleep(100);
  }
}

/** First decode times of the video and audio a session produced. */
async function firstVideoAndAudio(id: string) {
  const playlist = join(playbackDir(), id, "index.m3u8");
  const [video, audio] = await Promise.all([
    firstDecodeTime(playlist, "v:0"),
    firstDecodeTime(playlist, "a:0"),
  ]);
  if (video === null || audio === null) throw new Error("No packets");
  return { video, audio };
}

function segmentCount(playlist: string) {
  return [...playlist.matchAll(/#EXTINF:/g)].length;
}

/** The ffmpeg processes reported since `from`: started, and still running. */
function ffmpegPids(events: { pid: number; alive: boolean }[], from = 0) {
  const started = events.slice(from).filter((e) => e.alive);
  return started
    .map((e) => e.pid)
    .filter((pid) => !events.some((e) => e.pid === pid && !e.alive));
}

describe.skipIf(!hasFfmpeg)("media routes with real ffmpeg", () => {
  let workDir: string;
  let slowFiles: FakeFile[];
  let internalServer: Server;
  let app: express.Express;
  let cleanupRuntime: () => Promise<void>;
  const childEvents: { pid: number; alive: boolean }[] = [];

  beforeAll(async () => {
    ({ cleanup: cleanupRuntime } = await useTestRuntime());
    setChildReporter((pid, alive) => childEvents.push({ pid, alive }));
    workDir = await mkdtemp(join(tmpdir(), "streamy-fixture-"));
    await writeFile(join(workDir, "eng.srt"), srt("Hello"));
    await writeFile(join(workDir, "spa.srt"), srt("Hola"));
    const fixture = join(workDir, "fixture.mkv");

    makeMedia(FFMPEG, [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1280x720:r=24:d=60",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=60",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:duration=60",
      "-i",
      join(workDir, "eng.srt"),
      "-i",
      join(workDir, "spa.srt"),
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-map",
      "2:a",
      "-map",
      "3:s",
      "-map",
      "4:s",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "30",
      "-g",
      "240",
      "-keyint_min",
      "240",
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-c:a:0",
      "aac",
      "-c:a:1",
      "ac3",
      "-c:s",
      "srt",
      "-metadata:s:a:0",
      "language=eng",
      "-metadata:s:a:1",
      "language=rus",
      "-metadata:s:s:0",
      "language=eng",
      "-metadata:s:s:1",
      "language=spa",
      fixture,
    ]);
    const russian = join(workDir, "ru.srt");
    await writeFile(russian, cp1251(RUSSIAN_SRT));
    const picture = join(workDir, "picture.sub");
    await writeFile(picture, "not really VobSub");

    const files = (video: Partial<FakeFile>): FakeFile[] => [
      { name: "Fixture.mkv", path: fixture, ...video },
      { name: "Fixture.ru.srt", path: russian },
      { name: "Fixture.sub", path: picture },
    ];
    fakeTorrents.add(HASH, files({}));
    // ~1 MB/s: keeps ffmpeg busy for a while.
    slowFiles = files({ slowMs: 64 });
    fakeTorrents.add(SLOW_HASH, slowFiles);
    fakeTorrents.add(PARTIAL_HASH, files({ progress: 0.5 }));

    app = express();
    app.use(express.json());
    // ffmpeg's way in, as in the engine (the token is the permission).
    app.get("/internal/files/:token", internalFilesGet.handler);
    app.use("/v1", mediaRouter);
    app.use(errorHandler);
    internalServer = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => internalServer.once("listening", resolve));
    const { port } = internalServer.address() as AddressInfo;
    setInternalOrigin(`http://127.0.0.1:${port}`);
  }, 60_000);

  afterAll(async () => {
    await playbackService.shutdown();
    setChildReporter(null);
    revokeAllFileTokens();
    setInternalOrigin(null);
    internalServer.closeAllConnections();
    internalServer.close();
    await rm(workDir, { recursive: true, force: true });
    await cleanupRuntime();
  });

  it("reads the media info", { timeout: 30_000 }, async () => {
    const res = await request(app).get(`/v1/torrents/${HASH}/files/0/media`);

    expect(res.status).toBe(200);
    const media = res.body.media;
    expect(media.duration).toBeCloseTo(60, 0);
    expect(media.container).toBe("matroska,webm");
    expect(media.video).toMatchObject({
      codec: "h264",
      width: 1280,
      height: 720,
      fps: 24,
      bitDepth: 8,
      hdr: false,
    });
    expect(media.audioTracks).toMatchObject([
      { index: 0, codec: "aac", language: "en" },
      { index: 1, codec: "ac3", language: "ru" },
    ]);
    expect(media.subtitleTracks).toMatchObject([
      { id: "embedded:0", codec: "subrip", language: "en", isText: true },
      { id: "embedded:1", codec: "subrip", language: "es", isText: true },
      { id: "file:1", source: "file", language: "ru", title: "Fixture.ru.srt" },
    ]);
  });

  it("validates params and passes torrent errors through", async () => {
    const bad = await request(app).get("/v1/torrents/nothex/files/0/media");
    expect(bad.status).toBe(400);
    const missing = await request(app).get(
      `/v1/torrents/${"c".repeat(40)}/files/0/media`,
    );
    expect(missing.status).toBe(404);
  });

  describe("a remux session from 23 s", { timeout: 60_000 }, () => {
    let id: string;
    let offset: number;

    it("starts at the keyframe before 23 s (offset ≈ 20)", async () => {
      const res = await request(app)
        .post("/v1/playback")
        .send(playbackRequest({ start: 23, audioTrack: 1 }));

      expect(res.status).toBe(201);
      const playback = res.body.playback;
      expect(playback).toMatchObject({
        mode: "remux",
        url: `/v1/playback/${playback.id}/index.m3u8`,
        duration: expect.closeTo(60, 0),
        encoder: "copy",
        output: {
          videoCodec: "h264",
          audioCodec: "aac",
          width: 1280,
          height: 720,
        },
      });
      expect(playback.reason).toContain("MKV isn't playable directly");
      // Every stream starts at the keyframe at 20 s (the video decodes from
      // 19.917, two B-frames early): currentTime 0 is the earliest of them.
      expect(playback.offset).toBeGreaterThan(19.8);
      expect(playback.offset).toBeLessThanOrEqual(20);
      id = playback.id;
      offset = playback.offset;
    });

    it("starts the converted audio with the video (A/V sync)", async () => {
      const first = await firstVideoAndAudio(id);
      expect(Math.abs(first.audio - first.video)).toBeLessThan(0.05);
      expect(first.video).toBeGreaterThan(19.8);
      expect(offset).toBeCloseTo(Math.min(first.video, first.audio), 3);
    });

    it("serves the playlist, init segment and segments", async () => {
      const playlist = await request(app).get(`/v1/playback/${id}/index.m3u8`);
      expect(playlist.status).toBe(200);
      expect(playlist.headers["content-type"]).toContain(
        "application/vnd.apple.mpegurl",
      );
      expect(playlist.headers["cache-control"]).toBe("no-store");
      expect(playlist.text).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
      expect(playlist.text).toContain("seg_00000.m4s");

      const init = await request(app).get(`/v1/playback/${id}/init.mp4`);
      expect(init.status).toBe(200);
      expect(init.headers["content-type"]).toContain("video/mp4");

      const segment = await request(app).get(
        `/v1/playback/${id}/seg_00000.m4s`,
      );
      expect(segment.status).toBe(200);
      expect(segment.headers["content-type"]).toContain("video/iso.segment");
      expect(Number(segment.headers["content-length"])).toBeGreaterThan(1000);
    });

    it("refuses any other file name", async () => {
      for (const file of [
        "sub_0.vtt",
        "seg_1.m4s",
        "..%2F..%2Fetc%2Fpasswd",
        "index.m3u8.tmp",
      ]) {
        const res = await request(app).get(`/v1/playback/${id}/${file}`);
        expect(res.status).toBe(400);
      }
      const missing = await request(app).get(
        `/v1/playback/${id}/seg_99999.m4s`,
      );
      expect(missing.status).toBe(404);
      const unknown = await request(app).get("/v1/playback/nope/index.m3u8");
      expect(unknown.status).toBe(404);
    });

    it("returns embedded cues on the movie timeline", async () => {
      const body = await waitFor(async () => {
        const res = await request(app).get(
          `/v1/playback/${id}/subtitles/0?from=0&to=100`,
        );
        expect(res.status).toBe(200);
        const body = res.body as SubtitleCuesResponse;
        return body.cues.length > 10 && body;
      });
      expect(body.coveredFrom).toBe(offset);
      expect(body.coveredTo).toBeGreaterThan(offset);
      expect(body.cues[0]).toEqual({
        start: 20.5,
        end: 22,
        text: "Hello <i>10</i> & more",
      });
      for (const cue of body.cues) expect(cue.start).toBeGreaterThanOrEqual(20);

      const ranged = await request(app).get(
        `/v1/playback/${id}/subtitles/1?from=30&to=33`,
      );
      expect(ranged.body.cues.map((c: { text: string }) => c.text)).toEqual([
        "Hola <i>15</i> & more",
        "Hola <i>16</i> & more",
      ]);

      const noTrack = await request(app).get(`/v1/playback/${id}/subtitles/5`);
      expect(noTrack.status).toBe(404);
    });

    it("reports finished with producedUntil at the end", async () => {
      const status = await waitFor(async () => {
        const res = await request(app)
          .post(`/v1/playback/${id}/heartbeat`)
          .send({ position: 25, paused: false });
        const status = res.body.status as PlaybackStatus;
        return status.state === "finished" && status;
      });
      expect(status.producedUntil).toBeGreaterThan(59);
      expect(status.error).toBeNull();
    });

    it("a blocking reload of a finished playlist answers at once", async () => {
      const started = Date.now();
      const res = await request(app).get(
        `/v1/playback/${id}/index.m3u8?_HLS_msn=999`,
      );
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(res.text).toContain("#EXT-X-ENDLIST");
      expect(res.text).not.toContain(SERVER_CONTROL_TAG);
    });

    it("probes the offset from the first segment while the playlist looks live", async () => {
      // A playlist without #EXT-X-ENDLIST is "live": by default ffprobe
      // would start 3 segments from the end (30 s here, not 20 s).
      const dir = join(playbackDir(), id);
      const finished = await readFile(join(dir, "index.m3u8"), "utf8");
      expect(segmentCount(finished)).toBeGreaterThanOrEqual(4);
      const live = join(dir, "live.m3u8");
      await writeFile(live, finished.replace("#EXT-X-ENDLIST\n", ""));
      expect(await probeSessionOffset(live, true)).toBeCloseTo(offset, 3);
    });

    it("DELETE removes the folder; the session is gone", async () => {
      expect(existsSync(join(playbackDir(), id))).toBe(true);
      const res = await request(app).delete(`/v1/playback/${id}`);
      expect(res.status).toBe(204);
      expect(existsSync(join(playbackDir(), id))).toBe(false);
      const after = await request(app).get(`/v1/playback/${id}/index.m3u8`);
      expect(after.status).toBe(404);
      // Deleting again is fine.
      expect((await request(app).delete(`/v1/playback/${id}`)).status).toBe(
        204,
      );
    });
  });

  it(
    "remux audio stays in sync wherever it starts (on or between keyframes)",
    { timeout: 60_000 },
    async () => {
      // 30 = right on a keyframe; 47.3 = mid-GOP. AC3 → AAC both times.
      for (const start of [30, 47.3]) {
        const res = await request(app)
          .post("/v1/playback")
          .send(playbackRequest({ start, audioTrack: 1 }));
        expect(res.status).toBe(201);
        const id: string = res.body.playback.id;
        const first = await firstVideoAndAudio(id);
        expect(Math.abs(first.audio - first.video)).toBeLessThan(0.05);
        // Real movie times, not reset to 0.
        expect(first.video).toBeGreaterThan(10);
        expect(first.audio).toBeGreaterThan(10);
        expect(first.video).toBeLessThanOrEqual(start);
        expect(res.body.playback.offset).toBeCloseTo(
          Math.min(first.video, first.audio),
          3,
        );
        await request(app).delete(`/v1/playback/${id}`);
      }
    },
  );

  it("a 480p transcode makes 4 s segments", { timeout: 60_000 }, async () => {
    const res = await request(app)
      .post("/v1/playback")
      .send(playbackRequest({ start: 23, quality: "480p", audioTrack: 1 }));

    expect(res.status).toBe(201);
    const playback = res.body.playback;
    expect(playback).toMatchObject({
      mode: "transcode",
      reason: "Lower quality (480p) requested. AC3 audio is converted to AAC",
      output: {
        videoCodec: "h264",
        audioCodec: "aac",
        width: 854,
        height: 480,
      },
    });
    expect(playback.encoder).toMatch(
      /^(h264_videotoolbox|libx264|h264_nvenc|h264_qsv|h264_vaapi)$/,
    );
    // Starts at the keyframe before 23 s; the audio (AC3: its packets don't
    // line up with the keyframe) is cut to start with the first video frame,
    // minus the AAC encoder's ~23 ms priming.
    const first = await firstVideoAndAudio(playback.id);
    expect(first.video).toBeCloseTo(20, 2);
    expect(Math.abs(first.audio - first.video)).toBeLessThan(0.03);
    expect(playback.offset).toBeCloseTo(Math.min(first.video, first.audio), 3);

    const playlist = await waitFor(async () => {
      const text = (
        await request(app).get(`/v1/playback/${playback.id}/index.m3u8`)
      ).text;
      return text.includes("#EXT-X-ENDLIST") && text;
    }, 30_000);
    expect(playlist).toContain("#EXT-X-TARGETDURATION:4");
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(durations.length).toBeGreaterThan(5);
    for (const d of durations.slice(0, -1)) expect(d).toBeCloseTo(4, 1);

    expect(
      (await request(app).delete(`/v1/playback/${playback.id}`)).status,
    ).toBe(204);
  });

  it(
    "holds ffmpeg's input back far ahead, lets it go, and DELETE still kills it",
    { timeout: 60_000 },
    async () => {
      const ahead = getRuntime().tuning.transcodeAheadSeconds;
      updateTuning({ transcodeAheadSeconds: 8 });
      try {
        const res = await request(app)
          .post("/v1/playback")
          .send(playbackRequest({ infoHash: SLOW_HASH }));
        expect(res.status).toBe(201);
        const id: string = res.body.playback.id;
        const pid = playbackService.pid(id);
        expect(pid).not.toBeNull();
        const beat = async (position: number, paused = false) =>
          (
            await request(app)
              .post(`/v1/playback/${id}/heartbeat`)
              .send({ position, paused })
          ).body.status as PlaybackStatus;

        // The first remux segment is 10 s long (the GOP): already > 8 s ahead of 0.
        expect((await beat(0)).state).toBe("throttled");

        // A blocking reload for a segment that won't come is held for
        // min(3 × target duration, 12 s), then gets the playlist as it is.
        const playlist = await request(app).get(
          `/v1/playback/${id}/index.m3u8`,
        );
        expect(playlist.text).toContain(SERVER_CONTROL_TAG);
        const started = Date.now();
        const held = await request(app).get(
          `/v1/playback/${id}/index.m3u8?_HLS_msn=99&_HLS_part=0`,
        );
        const waited = Date.now() - started;
        expect(held.status).toBe(200);
        expect(waited).toBeGreaterThan(11_500);
        expect(waited).toBeLessThan(14_000);

        // Nothing more gets produced while it's held back (what was already
        // on its way may still make one segment), and ffmpeg just waits.
        const before = (await beat(1)).producedUntil ?? 0;
        expect(before).toBeLessThan(30);
        await sleep(2500);
        expect(await beat(1)).toMatchObject({
          state: "throttled",
          producedUntil: before,
        });
        expect(playbackService.pid(id)).toBe(pid);

        // The viewer caught up: it runs again.
        expect((await beat(before)).state).toBe("running");
        await waitFor(
          async () => ((await beat(before)).producedUntil ?? 0) > before,
        );

        // Held back again, then DELETE: ffmpeg is gone, and so is the folder.
        await beat(0, true);
        await waitFor(async () => (await beat(0, true)).state === "throttled");
        expect((await request(app).delete(`/v1/playback/${id}`)).status).toBe(
          204,
        );
        expect(processState(pid ?? 0)).toBeNull();
        expect(existsSync(join(playbackDir(), id))).toBe(false);
      } finally {
        updateTuning({ transcodeAheadSeconds: ahead });
      }
    },
  );

  it(
    "a blocking reload is held until the next segment exists",
    { timeout: 60_000 },
    async () => {
      const res = await request(app)
        .post("/v1/playback")
        .send(playbackRequest({ infoHash: SLOW_HASH }));
      expect(res.status).toBe(201);
      const id: string = res.body.playback.id;

      const playlist = await request(app).get(`/v1/playback/${id}/index.m3u8`);
      expect(playlist.text).toContain(
        `#EXT-X-TARGETDURATION:10\n${SERVER_CONTROL_TAG}\n`,
      );
      const listed = segmentCount(playlist.text);

      // Segments take ~1.5 s each from the slow source: it waits for exactly
      // the one asked for, not less and not the cap.
      const started = Date.now();
      const next = await request(app).get(
        `/v1/playback/${id}/index.m3u8?_HLS_msn=${listed}`,
      );
      expect(next.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(segmentCount(next.text)).toBe(listed + 1);
      expect(next.text).toContain(`seg_${String(listed).padStart(5, "0")}.m4s`);
      // Apart from the added tag, it's exactly what ffmpeg wrote.
      expect(next.text.replace(`${SERVER_CONTROL_TAG}\n`, "")).not.toContain(
        "SERVER-CONTROL",
      );

      const invalid = await request(app).get(
        `/v1/playback/${id}/index.m3u8?_HLS_msn=abc`,
      );
      expect(invalid.status).toBe(400);
      await request(app).delete(`/v1/playback/${id}`);
    },
  );

  it(
    "caps concurrent transcodes (MAX_TRANSCODES)",
    { timeout: 60_000 },
    async () => {
      const max = getRuntime().tuning.maxTranscodes;
      updateTuning({ maxTranscodes: 1 });
      try {
        const first = await request(app)
          .post("/v1/playback")
          .send(playbackRequest({ infoHash: SLOW_HASH, quality: "360p" }));
        expect(first.status).toBe(201);

        const second = await request(app)
          .post("/v1/playback")
          .send(playbackRequest({ quality: "360p" }));
        expect(second.status).toBe(503);
        expect(second.body.error.message).toBe(
          "Too many videos are being converted right now",
        );

        // Replacing the running one is fine: it's stopped first.
        const replacing = await request(app)
          .post("/v1/playback")
          .send(
            playbackRequest({
              quality: "360p",
              replaces: first.body.playback.id,
            }),
          );
        expect(replacing.status).toBe(201);
        expect(existsSync(join(playbackDir(), first.body.playback.id))).toBe(
          false,
        );
        await request(app).delete(`/v1/playback/${replacing.body.playback.id}`);
      } finally {
        updateTuning({ maxTranscodes: max });
      }
    },
  );

  it(
    "stops the session when the client gives up while it starts",
    { timeout: 30_000 },
    async () => {
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const abort = new AbortController();
        const pending = fetch(`http://127.0.0.1:${port}/v1/playback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            playbackRequest({ infoHash: SLOW_HASH, start: 40 }),
          ),
          signal: abort.signal,
        }).catch(() => null);
        const sessionDirs = () => readdir(playbackDir()).catch(() => []);
        await waitFor(async () => (await sessionDirs()).length > 0);
        abort.abort();
        await pending;
        await waitFor(async () => (await sessionDirs()).length === 0);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    },
  );

  it(
    "a torrent removed while a session starts stops it",
    { timeout: 30_000 },
    async () => {
      const pending = request(app)
        .post("/v1/playback")
        .send(playbackRequest({ infoHash: SLOW_HASH, start: 40 }))
        .then((res) => res);
      const sessionDirs = () => readdir(playbackDir()).catch(() => []);
      await waitFor(async () => (await sessionDirs()).length > 0);

      fakeTorrents.remove(SLOW_HASH);

      const res = await pending;
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe(
        "This playback was stopped before it started",
      );
      await waitFor(async () => (await sessionDirs()).length === 0);
      // Back, for the next tests.
      fakeTorrents.add(SLOW_HASH, slowFiles);
    },
  );

  describe("players (playerId)", { timeout: 60_000 }, () => {
    const sessionDirs = () => readdir(playbackDir()).catch(() => []);

    it("a new start stops the player's start still under way, and kills its ffmpeg", async () => {
      const from = childEvents.length;
      const first = request(app)
        .post("/v1/playback")
        .send(playbackRequest({ infoHash: SLOW_HASH, playerId: "p1" }))
        .then((res) => res);
      // Its ffmpeg runs (waiting for the slow first segment).
      await waitFor(() =>
        Promise.resolve(ffmpegPids(childEvents, from).length > 0),
      );
      const superseded = ffmpegPids(childEvents, from);

      const second = await request(app)
        .post("/v1/playback")
        .send(playbackRequest({ playerId: "p1", start: 30 }));
      expect(second.status).toBe(201);

      const answer = await first;
      expect(answer.status).toBe(409);
      expect(answer.body.error.message).toBe(
        "A newer playback replaced this one",
      );
      for (const pid of superseded) expect(processState(pid)).toBeNull();
      expect(await sessionDirs()).toEqual([second.body.playback.id]);
      await request(app).delete(`/v1/playback/${second.body.playback.id}`);
    });

    it("a new start stops the player's running session (replaces still works too)", async () => {
      const first = await request(app)
        .post("/v1/playback")
        .send(playbackRequest({ playerId: "p2" }));
      const other = await request(app)
        .post("/v1/playback")
        .send(playbackRequest({ playerId: "someone-else" }));
      const second = await request(app)
        .post("/v1/playback")
        .send(
          playbackRequest({
            playerId: "p2",
            start: 30,
            replaces: first.body.playback.id,
          }),
        );
      expect(second.status).toBe(201);
      expect(existsSync(join(playbackDir(), first.body.playback.id))).toBe(
        false,
      );
      // Another player's session is left alone.
      expect(existsSync(join(playbackDir(), other.body.playback.id))).toBe(
        true,
      );
      await request(app).delete(`/v1/players/someone-else`).expect(204);
      await request(app).delete(`/v1/players/p2`).expect(204);
      expect(await sessionDirs()).toEqual([]);
    });

    it("DELETE /v1/players/:id stops its sessions and its start under way", async () => {
      const running = await request(app)
        .post("/v1/playback")
        .send(playbackRequest({ forceMode: "direct", playerId: "p3" }));
      expect(playbackService.isPlaying(HASH)).toBe(true);
      const from = childEvents.length;
      const starting = request(app)
        .post("/v1/playback")
        .send(
          playbackRequest({ infoHash: SLOW_HASH, start: 40, playerId: "p3" }),
        )
        .then((res) => res);
      await waitFor(() =>
        Promise.resolve(ffmpegPids(childEvents, from).length > 0),
      );
      const pids = ffmpegPids(childEvents, from);

      expect((await request(app).delete("/v1/players/p3")).status).toBe(204);

      expect((await starting).status).toBe(404);
      for (const pid of pids) expect(processState(pid)).toBeNull();
      expect(await sessionDirs()).toEqual([]);
      expect(playbackService.isPlaying(HASH)).toBe(false);
      const gone = await request(app)
        .post(`/v1/playback/${running.body.playback.id}/heartbeat`)
        .send({ position: 1, paused: false });
      expect(gone.status).toBe(404);
      // Unknown players are fine; odd ids are refused.
      expect((await request(app).delete("/v1/players/nobody")).status).toBe(
        204,
      );
      expect((await request(app).delete("/v1/players/a%20b")).status).toBe(400);
    });

    it("a create without playerId is refused", async () => {
      const { playerId, ...rest } = playbackRequest();
      expect(playerId).toBeTruthy();
      const res = await request(app).post("/v1/playback").send(rest);
      expect(res.status).toBe(400);
    });
  });

  it(
    "counts transcodes still starting against MAX_TRANSCODES",
    { timeout: 60_000 },
    async () => {
      const max = getRuntime().tuning.maxTranscodes;
      updateTuning({ maxTranscodes: 1 });
      try {
        // Both at once: the first is still probing its first frame (slow source).
        const answers = await Promise.all([
          request(app)
            .post("/v1/playback")
            .send(playbackRequest({ infoHash: SLOW_HASH, quality: "360p" })),
          sleep(300).then(() =>
            request(app)
              .post("/v1/playback")
              .send(playbackRequest({ quality: "360p", start: 30 })),
          ),
        ]);
        expect(answers.map((res) => res.status)).toEqual([201, 503]);
        await playbackService.stopAll();
      } finally {
        updateTuning({ maxTranscodes: max });
      }
    },
  );

  describe("while the disk is almost full", () => {
    beforeAll(() => {
      setEngineServices({
        diskGuard: { isLow: () => true },
      } as unknown as EngineServices);
    });
    afterAll(() => {
      setEngineServices(null);
    });

    it("still plays a downloaded file directly", async () => {
      const res = await request(app)
        .post("/v1/playback")
        .send(playbackRequest({ forceMode: "direct" }));
      expect(res.status).toBe(201);
      await request(app).delete(`/v1/playback/${res.body.playback.id}`);
    });

    it("refuses remux/transcode, and an unfinished file", async () => {
      for (const body of [
        playbackRequest(),
        playbackRequest({ quality: "360p" }),
        playbackRequest({ infoHash: PARTIAL_HASH, forceMode: "direct" }),
      ]) {
        const res = await request(app).post("/v1/playback").send(body);
        expect(res.status).toBe(503);
        expect(res.body.error.message).toBe(
          "Your disk is almost full. Free up some space, then try again.",
        );
      }
      expect(await readdir(playbackDir()).catch(() => [])).toEqual([]);
    });
  });

  it(
    "works in a video folder whose path has %d in it",
    { timeout: 30_000 },
    async () => {
      const config = getRuntime().config;
      const odd = join(workDir, "videos %d %05d");
      await makeVideoFolder(odd);
      updateConfig({ ...config, cacheDir: odd });
      try {
        const res = await request(app)
          .post("/v1/playback")
          .send(playbackRequest({ start: 30 }));
        expect(res.status).toBe(201);
        const files = await readdir(
          join(odd, "playback", res.body.playback.id),
        );
        expect(files).toEqual(
          expect.arrayContaining(["index.m3u8", "init.mp4", "seg_00000.m4s"]),
        );
        await request(app).delete(`/v1/playback/${res.body.playback.id}`);
      } finally {
        updateConfig(config);
      }
    },
  );

  it("plays an MP4-like direct file without ffmpeg (forceMode direct)", async () => {
    const res = await request(app)
      .post("/v1/playback")
      .send(playbackRequest({ forceMode: "direct" }));
    expect(res.status).toBe(201);
    expect(res.body.playback).toMatchObject({
      mode: "direct",
      url: `/v1/torrents/${HASH}/files/0/stream`,
      offset: 0,
      encoder: null,
    });
    const beat = await request(app)
      .post(`/v1/playback/${res.body.playback.id}/heartbeat`)
      .send({ position: 12, paused: false });
    expect(beat.body.status).toEqual({
      state: "running",
      producedUntil: null,
      error: null,
    });
    const hls = await request(app).get(
      `/v1/playback/${res.body.playback.id}/index.m3u8`,
    );
    expect(hls.status).toBe(404);

    // A live session: its torrent is never stopped to save resources.
    expect(playbackService.isPlaying(HASH)).toBe(true);
    expect(playbackService.isPlaying(SLOW_HASH)).toBe(false);
    await request(app).delete(`/v1/playback/${res.body.playback.id}`);
    expect(playbackService.isPlaying(HASH)).toBe(false);
  });

  it("rejects bad playback requests", async () => {
    const noCaps = await request(app)
      .post("/v1/playback")
      .send({ infoHash: HASH, fileIndex: 0 });
    expect(noCaps.status).toBe(400);
    expect(noCaps.body.error.code).toBe("VALIDATION_FAILED");

    const badTrack = await request(app)
      .post("/v1/playback")
      .send(playbackRequest({ audioTrack: 7 }));
    expect(badTrack.status).toBe(400);
    expect(badTrack.body.error.message).toBe("This audio track doesn't exist");

    const unknown = await request(app)
      .post("/v1/playback/nope/heartbeat")
      .send({ position: 1, paused: false });
    expect(unknown.status).toBe(404);
  });

  it("tells heartbeat listeners what to save (position, track, subtitle)", async () => {
    const events: PlaybackHeartbeatEvent[] = [];
    const unsubscribe = playbackService.onHeartbeat((event) =>
      events.push(event),
    );
    const res = await request(app)
      .post("/v1/playback")
      .send(playbackRequest({ forceMode: "direct", audioTrack: 0 }));
    const id: string = res.body.playback.id;

    await request(app)
      .post(`/v1/playback/${id}/heartbeat`)
      .send({ position: 42.5, paused: true, subtitle: "embedded:1" })
      .expect(200);
    await request(app)
      .post(`/v1/playback/${id}/heartbeat`)
      .send({ position: 43, paused: false })
      .expect(200);
    const bad = await request(app)
      .post(`/v1/playback/${id}/heartbeat`)
      .send({ position: 44, paused: false, subtitle: 5 });
    expect(bad.status).toBe(400);

    expect(events).toEqual([
      {
        sessionId: id,
        infoHash: HASH,
        fileIndex: 0,
        fileName: "Fixture.mkv",
        position: 42.5,
        duration: expect.closeTo(60, 0),
        paused: true,
        audioTrack: 0,
        subtitle: "embedded:1",
      },
      expect.objectContaining({ position: 43, subtitle: undefined }),
    ]);
    unsubscribe();
    await request(app).delete(`/v1/playback/${id}`);
  });

  it(
    'transcodes with libx264 when hardware encoding is "off"',
    { timeout: 60_000 },
    async () => {
      const config = getRuntime().config;
      updateConfig({ ...config, hardwareEncoding: "off" });
      try {
        const res = await request(app)
          .post("/v1/playback")
          .send(playbackRequest({ start: 50, quality: "360p" }));
        expect(res.status).toBe(201);
        expect(res.body.playback).toMatchObject({
          mode: "transcode",
          encoder: "libx264",
        });
        await request(app).delete(`/v1/playback/${res.body.playback.id}`);
      } finally {
        updateConfig(config);
      }
    },
  );

  it("revokes every internal URL and reports every ffmpeg/ffprobe it ran", async () => {
    await playbackService.stopAll();
    // Offset probes may still be finishing.
    await vi.waitFor(() => {
      expect(runningChildCount()).toBe(0);
    });

    expect(fakeTorrents.tokens.minted).toBeGreaterThan(5);
    expect(fakeTorrents.tokens.revoked).toBe(fakeTorrents.tokens.minted);

    const started = childEvents.filter((e) => e.alive).map((e) => e.pid);
    const ended = childEvents.filter((e) => !e.alive).map((e) => e.pid);
    expect(started.length).toBeGreaterThan(5);
    expect(ended.sort()).toEqual(started.sort());
  });

  describe("subtitle files", () => {
    it(
      "converts a cp1251 .srt to UTF-8 cues",
      { timeout: 30_000 },
      async () => {
        const res = await request(app).get(
          `/v1/torrents/${HASH}/files/1/subtitles`,
        );
        expect(res.status).toBe(200);
        expect(res.body.cues).toEqual([
          {
            start: 1,
            end: 3.5,
            text: "Привет, как дела? Это проверка кодировки.",
          },
          {
            start: 4,
            end: 6,
            text: "<i>Ёжик в тумане</i> & друзья\nВторая строка",
          },
        ]);
        // Cached: the second call doesn't read the file again.
        const again = await request(app).get(
          `/v1/torrents/${HASH}/files/1/subtitles`,
        );
        expect(again.body).toEqual(res.body);
      },
    );

    it("refuses picture subtitle files", async () => {
      const res = await request(app).get(
        `/v1/torrents/${HASH}/files/2/subtitles`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe(
        "Only text subtitle files are supported",
      );
    });
  });
});
