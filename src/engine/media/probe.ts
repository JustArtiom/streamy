import type {
  AudioTrack,
  MediaInfo,
  SubtitleTrack,
  VideoInfo,
} from "../../shared/engine-api";
import { redact } from "../../shared/redact";
import { getRuntime } from "../config";
import { AppError, ErrorCode } from "../http/errors";
import { logger } from "../lib/logger";
import { normalizeLanguage } from "./languages";
import {
  buildFirstFrameProbeArgs,
  type HdrTransfer,
  parseShowinfoTime,
  torrentInputArgs,
} from "./ffmpeg-args";
import { lastLines, runProcess } from "./run";

/*
 * ffprobe → MediaInfo. ffprobe reads the internal stream URL, so it only
 * fetches the pieces holding the header (and the index at the end of some
 * MP4s), never the whole file.
 */

type Disposition = Partial<Record<string, number>>;

export type ProbeStream = {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_transfer?: string;
  /** "progressive", "tt", "bb", "tb", "bt" or "unknown". */
  field_order?: string;
  channels?: number;
  disposition?: Disposition;
  tags?: Partial<Record<string, string>>;
};

export type ProbeOutput = {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    start_time?: string;
  };
  streams?: ProbeStream[];
  packets?: { dts_time?: string }[];
};

/** MediaInfo plus what ffmpeg needs that the API doesn't show. */
export type ProbedMedia = {
  info: MediaInfo;
  /** ffmpeg's `0:v:<videoIndex>`: the real video, skipping cover art. */
  videoIndex: number;
  /**
   * format.start_time (s): the file's own timestamp at movie time 0. Not 0
   * for most .ts files (1.4 s, or 1001 s for a TV recording).
   */
  startTime: number;
  /** The HDR transfer to tone-map from; null = SDR (or video.hdr false). */
  hdrTransfer: HdrTransfer | null;
  /** Interlaced video (TV, DVD): transcodes deinterlace it. */
  interlaced: boolean;
};

/** Codecs ffmpeg can turn into WebVTT text. The rest are pictures (PGS, VobSub, DVB). */
const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "mov_text",
  "webvtt",
  "text",
]);

const HDR_TRANSFERS: readonly HdrTransfer[] = ["smpte2084", "arib-std-b67"];

function hdrTransferOf(stream: ProbeStream): HdrTransfer | null {
  return (
    HDR_TRANSFERS.find((transfer) => transfer === stream.color_transfer) ?? null
  );
}

/** Field orders of interlaced video (top/bottom field first, and coded orders). */
const INTERLACED_FIELD_ORDERS = new Set(["tt", "bb", "tb", "bt"]);

const log = logger.child({ module: "probe" });

function number(value: string | number | undefined): number | null {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/** "24000/1001" → 23.976. "0/0" → null. */
export function parseFrameRate(rate: string | undefined): number | null {
  const [num, den] = (rate ?? "").split("/").map(Number);
  if (!num || !den || !Number.isFinite(num / den)) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/** From bits_per_raw_sample, else the pixel format ("yuv420p10le" → 10), else 8. */
export function bitDepthOf(stream: ProbeStream): number {
  const raw = number(stream.bits_per_raw_sample);
  if (raw && raw >= 8) return raw;
  const match = /p(\d{2})(?:le|be)$/.exec(stream.pix_fmt ?? "");
  return match ? Number(match[1]) : 8;
}

function flag(disposition: Disposition | undefined, name: string) {
  return disposition?.[name] === 1;
}

function textOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Maps ffprobe's JSON to MediaInfo (embedded subtitle tracks only). */
export function toProbedMedia(probe: ProbeOutput): ProbedMedia {
  const streams = probe.streams ?? [];
  const videos = streams.filter((s) => s.codec_type === "video");
  const videoIndex = videos.findIndex(
    (s) => !flag(s.disposition, "attached_pic"),
  );
  const videoStream = videoIndex >= 0 ? videos[videoIndex] : undefined;

  if (!videoStream) {
    throw new AppError(ErrorCode.BadRequest, "This file has no video");
  }

  const video: VideoInfo = {
    codec: videoStream.codec_name ?? "unknown",
    profile: textOrNull(videoStream.profile),
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps:
      parseFrameRate(videoStream.avg_frame_rate) ??
      parseFrameRate(videoStream.r_frame_rate),
    bitDepth: bitDepthOf(videoStream),
    hdr: hdrTransferOf(videoStream) !== null,
  };

  const audioTracks: AudioTrack[] = streams
    .filter((s) => s.codec_type === "audio")
    .map((s, index) => ({
      index,
      codec: s.codec_name ?? "unknown",
      channels: s.channels ?? 2,
      language: normalizeLanguage(s.tags?.language),
      title: textOrNull(s.tags?.title),
      isDefault: flag(s.disposition, "default"),
    }));

  const subtitleTracks: SubtitleTrack[] = streams
    .filter((s) => s.codec_type === "subtitle")
    .map((s, index) => ({
      id: `embedded:${index}`,
      source: "embedded",
      codec: s.codec_name ?? "unknown",
      language: normalizeLanguage(s.tags?.language),
      title: textOrNull(s.tags?.title),
      isDefault: flag(s.disposition, "default"),
      isForced: flag(s.disposition, "forced"),
      isText: TEXT_SUBTITLE_CODECS.has(s.codec_name ?? ""),
    }));

  const bitRate = number(probe.format?.bit_rate);
  return {
    videoIndex,
    startTime: number(probe.format?.start_time) ?? 0,
    hdrTransfer: hdrTransferOf(videoStream),
    interlaced: INTERLACED_FIELD_ORDERS.has(videoStream.field_order ?? ""),
    info: {
      duration: number(probe.format?.duration) ?? 0,
      container: probe.format?.format_name ?? "unknown",
      bitRate: bitRate === null ? null : Math.round(bitRate),
      video,
      audioTracks,
      subtitleTracks,
    },
  };
}

const PROBE_TIMEOUT_MS = 120_000;

/** Runs ffprobe on a torrent file's token URL. Throws 503 on timeout or missing ffprobe. */
export async function ffprobe(input: string): Promise<ProbeOutput> {
  const result = await runProcess(
    getRuntime().ffprobePath,
    // prettier-ignore
    [
      "-v", "error",
      ...torrentInputArgs(),
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      input,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );

  if (result.timedOut) {
    throw new AppError(
      ErrorCode.ServiceUnavailable,
      "Couldn't read the video info in time. The torrent may be too slow.",
    );
  }
  if (result.code !== 0) {
    // ffprobe's own words (and our token URL) stay in the log.
    log.warn(
      { code: result.code, stderr: lastLines(redact(result.stderr), 3) },
      "ffprobe failed",
    );
    throw new AppError(
      ErrorCode.BadRequest,
      "Couldn't read this file as a video",
    );
  }
  return JSON.parse(result.stdout.toString("utf8")) as ProbeOutput;
}

/**
 * Runs a quick ffprobe on a session's local playlist; null on any failure.
 * -live_start_index 0: without #EXT-X-ENDLIST the playlist looks live, and
 * ffprobe would start 3 segments from the end instead of at the first one.
 */
async function probePlaylist(
  playlistPath: string,
  args: string[],
): Promise<ProbeOutput | null> {
  const result = await runProcess(
    getRuntime().ffprobePath,
    // prettier-ignore
    ["-v", "error", ...args, "-of", "json", "-live_start_index", "0", playlistPath],
    { timeoutMs: 15_000 },
  ).catch(() => null);
  if (!result || result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout.toString("utf8")) as ProbeOutput;
  } catch {
    return null;
  }
}

/** The decode time of the first packet of `stream` ("v:0", "a:0") in a session's playlist. */
export async function firstDecodeTime(playlistPath: string, stream: string) {
  const parsed = await probePlaylist(playlistPath, [
    "-select_streams",
    stream,
    "-show_entries",
    "packet=dts_time",
    "-read_intervals",
    "%+#1",
  ]);
  return number(parsed?.packets?.[0]?.dts_time);
}

/**
 * Where a session's HLS output really starts on the movie timeline (the
 * session `offset`). Remux starts at the keyframe before `start`, copied
 * audio can start a bit earlier still, and B-frames put the first video
 * decode time a frame or two before its display time. hls.js puts
 * currentTime 0 at the earliest decode time of all tracks (their tfdt), so
 * that's what this returns. Falls back to the playlist's format start_time,
 * then null.
 */
export async function probeSessionOffset(
  playlistPath: string,
  hasAudio: boolean,
): Promise<number | null> {
  const starts = await Promise.all([
    firstDecodeTime(playlistPath, "v:0"),
    hasAudio ? firstDecodeTime(playlistPath, "a:0") : null,
  ]);
  const known = starts.filter((start) => start !== null);
  if (known.length > 0) return Math.min(...known);

  const parsed = await probePlaylist(playlistPath, [
    "-show_entries",
    "format=start_time",
  ]);
  return number(parsed?.format?.start_time);
}

/**
 * The time of the first video frame a session starting at `start` will
 * produce (the keyframe ffmpeg's seek lands on), on the file's own clock
 * (movie time + ProbedMedia.startTime). Transcode cuts the audio there.
 * null when it can't tell (timeout, error, cancelled).
 */
export async function probeFirstFrameTime(
  input: string,
  start: number,
  videoIndex: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const result = await runProcess(
    getRuntime().ffmpegPath,
    buildFirstFrameProbeArgs(input, start, videoIndex),
    { timeoutMs: 30_000, signal },
  ).catch(() => null);
  if (!result || result.code !== 0) return null;
  return parseShowinfoTime(result.stderr);
}
