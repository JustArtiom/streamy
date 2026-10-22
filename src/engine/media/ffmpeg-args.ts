import {
  hardwareInputArgs,
  outputPixelFormatFilter,
  type VideoEncoder,
} from "./encoders";

/*
 * The ffmpeg command lines for a playback session, as argument arrays
 * (never a shell string). Pure, so the exact recipes are tested.
 *
 * Facts these rely on (verified with ffmpeg 8):
 * - `-copyts -ss T` before `-i` keeps real timestamps, so segment and
 *   subtitle times are movie times. Remux starts at the keyframe before T.
 *   `-ss` counts from the file's start_time, but -copyts output keeps the
 *   file's own clock: `-output_ts_offset -start_time` puts every output back
 *   on the movie's timeline (a TS recording can start at PTS 1001 s).
 * - hls.js lines up the FIRST audio and video samples of a session, so both
 *   must start at the same movie time or they play out of sync (see
 *   seekInputArgs, and the transcode video/audio options).
 * - Transcode needs BOTH -g and -force_key_frames to get a keyframe exactly
 *   every SEG seconds (without -g, videotoolbox adds one every 0.5 s).
 * - `-hls_playlist_type event` (not vod: vod only writes the playlist at the end).
 * - Never `-progress`/out_time (garbage with -copyts) or `-readrate`.
 * - Never `-xerror`: it stops on the first damaged packet or frame, and
 *   torrents are full of slightly damaged files that play fine otherwise.
 * - Outputs are relative names: ffmpeg runs inside the session folder, so
 *   a "%d" in the video folder's path can't reach the segment template.
 */

/**
 * The containers torrent data may be read as (`-format_whitelist`, matched
 * against each demuxer's names). Streamy's video extensions all map here:
 * .mkv/.webm → matroska, .mp4/.m4v/.mov/.3gp → mov, .ts/.m2ts/.mts →
 * mpegts, .mpg/.mpeg → mpeg (or mpegvideo when it's a bare video stream),
 * .wmv → asf, .ogv → ogg, plus avi and flv.
 *
 * Everything else is refused, above all the formats that are playlists
 * (hls, dash, concat, sdp…): a "movie" that's really one would make ffmpeg
 * fetch whatever URLs it lists, on the LAN or the internet.
 */
export const TORRENT_INPUT_FORMATS = [
  "matroska",
  "mov",
  "mpegts",
  "mpeg",
  "mpegvideo",
  "avi",
  "flv",
  "asf",
  "ogg",
] as const;

/**
 * Before every `-i` (ffmpeg) or input (ffprobe) that reads torrent data,
 * which is always our loopback token URL:
 * - only the containers above, only http over tcp;
 * - a connection that drops mid-file reconnects where it stopped (retries
 *   after 0, 1, 3, 7 s). An HTTP error (the token revoked) still fails.
 *   Held-back reads (throttling) never time out: ffmpeg's http input has
 *   no read timeout by default.
 */
export function torrentInputArgs(): string[] {
  // prettier-ignore
  return [
    "-format_whitelist", TORRENT_INPUT_FORMATS.join(","),
    "-protocol_whitelist", "http,tcp",
    "-reconnect", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "7",
  ];
}

/** HDR transfers transcoding tone-maps from (PQ, HLG). */
export type HdrTransfer = "smpte2084" | "arib-std-b67";

/** tonemapx (jellyfin-ffmpeg, fast) when the build has it, else zscale + tonemap. */
export type ToneMapper = "tonemapx" | "zscale";

export type VideoPlan =
  | {
      kind: "copy";
      /** Source codec: HEVC gets the hvc1 tag Apple/Chrome need. */
      codec: string;
    }
  | {
      kind: "encode";
      encoder: VideoEncoder;
      fps: number | null;
      /** HDR to tone-map to SDR; null = SDR already. */
      hdr: HdrTransfer | null;
      toneMapper: ToneMapper;
      /** Interlaced source: deinterlace (one frame per field). */
      deinterlace: boolean;
      /** Source size, to keep the output even (H.264 needs even sizes). */
      width: number;
      height: number;
      /** Scale down to this height, null = keep the size. */
      scaleToHeight: number | null;
      /** Embedded picture subtitle `0:s:<n>` to burn in. */
      burnSubtitle: number | null;
    };

export type SessionJob = {
  /** The internal stream URL (or a file in tests). */
  input: string;
  /** Movie time to start from (s). */
  start: number;
  /** The file's format start_time (s): its timestamps at movie time 0. */
  inputStartTime: number;
  segmentSeconds: number;
  /** ffmpeg's `0:v:<n>` (skips cover art). */
  videoIndex: number;
  /** ffmpeg's `0:a:<n>`, null when the file has no audio. */
  audioIndex: number | null;
  /** The source audio codec ("aac", "mp3", …), null without audio. */
  audioCodec: string | null;
  /** Copy the audio (remux only: transcode always re-encodes it). */
  audioCopy: boolean;
  /**
   * transcode: drop the audio before this time on the file's own clock (the
   * first video frame, from probeFirstFrameTime), so audio and video start
   * together. null = don't cut.
   */
  audioStart: number | null;
  video: VideoPlan;
  /** Embedded text subtitles `0:s:<n>` to extract into sub_<n>.vtt. */
  subtitleStreams: number[];
};

/** The session's files, relative to its folder (ffmpeg's working directory). */
export const PLAYLIST_FILE = "index.m3u8";
export const INIT_FILE = "init.mp4";
export const SEGMENT_TEMPLATE = "seg_%05d.m4s";
export function subtitleFile(n: number): string {
  return `sub_${n}.vtt`;
}

/** Video bitrate (kbit/s) by output height. */
export function videoBitrateKbps(height: number): number {
  if (height >= 2000) return 16_000;
  if (height >= 1400) return 10_000;
  if (height >= 1000) return 6_000;
  if (height >= 700) return 3_000;
  if (height >= 460) return 1_500;
  return 800;
}

type EncodePlan = Extract<VideoPlan, { kind: "encode" }>;

/** HDR → SDR (BT.709), in the pixel format the encoder takes next. */
export function toneMapFilter(
  transfer: HdrTransfer,
  toneMapper: ToneMapper,
  encoder: VideoEncoder,
): string {
  if (toneMapper === "tonemapx") {
    const format =
      encoder === "h264_qsv" || encoder === "h264_vaapi" ? "nv12" : "yuv420p";
    return `tonemapx=tonemap=bt2390:t=bt709:m=bt709:p=bt709:format=${format}`;
  }
  // zscale needs every input property spelled out: with untagged primaries
  // or matrix (common) it fails with "no path between colorspaces". HDR is
  // always BT.2020.
  return [
    `zscale=tin=${transfer}:pin=bt2020:min=bt2020nc:rin=tv:t=linear:p=bt2020:m=bt2020nc:npl=100`,
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
  ].join(",");
}

/**
 * bwdif makes one frame per field (smooth motion, double frame rate), and
 * leaves frames that aren't flagged interlaced alone (mixed content).
 */
const DEINTERLACE = "bwdif=mode=send_field:deint=interlaced";

/** The frame-by-frame part, after any burn-in: scale → HDR tone-map → the encoder's pixel format. */
export function videoFilterChain(video: EncodePlan): string {
  const filters: string[] = [];
  if (video.scaleToHeight !== null) {
    filters.push(`scale=-2:${video.scaleToHeight}`);
  } else if (video.width % 2 !== 0 || video.height % 2 !== 0) {
    filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  }
  if (video.hdr) {
    filters.push(toneMapFilter(video.hdr, video.toneMapper, video.encoder));
  }
  filters.push(outputPixelFormatFilter(video.encoder));
  return filters.join(",");
}

/**
 * The whole video filter: deinterlace, burn in a picture subtitle, then the
 * chain above. A picture subtitle is drawn on its own canvas (a 1080p PGS
 * on 720p video, a DVD canvas): it's scaled to the video's size first, or
 * it would land off-frame or at the wrong size.
 */
export function videoFilterArgs(
  video: EncodePlan,
  videoIndex: number,
): string[] {
  const chain = videoFilterChain(video);
  if (video.burnSubtitle === null) {
    const filters = video.deinterlace ? `${DEINTERLACE},${chain}` : chain;
    return ["-map", `0:v:${videoIndex}`, "-vf", filters];
  }
  const graph = [
    `[0:s:${video.burnSubtitle}]scale=${video.width}:${video.height}[sub]`,
    video.deinterlace
      ? `[0:v:${videoIndex}]${DEINTERLACE}[main];[main][sub]`
      : `[0:v:${videoIndex}][sub]`,
  ];
  return [
    "-filter_complex",
    `${graph[0]};${graph[1]}overlay=eof_action=pass,${chain}[v]`,
    "-map",
    "[v]",
  ];
}

export function encoderArgs(encoder: VideoEncoder, outputHeight: number) {
  const kbps = videoBitrateKbps(outputHeight);
  const rate = {
    bitrate: `${kbps}k`,
    maxrate: `${Math.round(kbps * 1.33)}k`,
    bufsize: `${kbps * 2}k`,
  };

  switch (encoder) {
    case "libx264":
      // prettier-ignore
      return [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "21",
        "-maxrate", rate.maxrate,
        "-bufsize", rate.bufsize,
        "-profile:v", "high",
        // 4.1 is the most compatible level, but it can't hold more than 1080p.
        "-level:v", outputHeight > 1088 ? "5.1" : "4.1",
        "-sc_threshold", "0",
      ];
    case "h264_videotoolbox":
      // prettier-ignore
      return [
        "-c:v", "h264_videotoolbox",
        "-b:v", rate.bitrate,
        "-maxrate", rate.maxrate,
        "-bufsize", rate.bufsize,
        "-profile:v", "high",
        "-allow_sw", "1",
      ];
    case "h264_nvenc":
      // prettier-ignore
      return [
        "-c:v", "h264_nvenc",
        "-preset", "p4",
        "-rc", "vbr",
        "-b:v", rate.bitrate,
        "-maxrate", rate.maxrate,
        "-bufsize", rate.bufsize,
        "-profile:v", "high",
        "-forced-idr", "1",
      ];
    // Best effort, not tested on real hardware.
    case "h264_qsv":
      // prettier-ignore
      return [
        "-c:v", "h264_qsv",
        "-b:v", rate.bitrate,
        "-maxrate", rate.maxrate,
        "-bufsize", rate.bufsize,
        // Forced keyframes must be IDR frames, or segments don't start cleanly.
        "-forced_idr", "1",
      ];
    case "h264_vaapi":
      // prettier-ignore
      return [
        "-c:v", "h264_vaapi",
        "-b:v", rate.bitrate,
        "-maxrate", rate.maxrate,
        "-bufsize", rate.bufsize,
      ];
  }
}

/** Movie time as ffmpeg likes it: "23", "23.5". */
function formatSeconds(seconds: number, decimals = 3) {
  return String(Number(seconds.toFixed(decimals)));
}

/**
 * The input part, shared by the session and probeFirstFrameTime so both
 * land on the same keyframe. -noaccurate_seek: every stream starts at the
 * keyframe before `start`. With the default accurate seek, re-encoded audio
 * starts at `start` (or even restarts at 0) while copied video starts at
 * the keyframe, and the player would line those up: audio early by seconds.
 */
export function seekInputArgs(input: string, start: number): string[] {
  return [
    ...torrentInputArgs(),
    "-copyts",
    ...(start > 0 ? ["-noaccurate_seek", "-ss", formatSeconds(start)] : []),
    "-i",
    input,
  ];
}

/** Per output: shifts the file's own clock (-copyts) onto the movie timeline. */
function movieTimeArgs(inputStartTime: number): string[] {
  return inputStartTime === 0
    ? []
    : ["-output_ts_offset", formatSeconds(-inputStartTime, 6)];
}

/** ffmpeg's arguments for a session. Run it with the session folder as its working directory. */
export function buildSessionArgs(job: SessionJob): string[] {
  const { video } = job;
  const seg = job.segmentSeconds;
  const args = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-y"];

  // Input: keep real timestamps, seek with Range requests.
  if (video.kind === "encode") args.push(...hardwareInputArgs(video.encoder));
  args.push(...seekInputArgs(job.input, job.start));

  // Video
  if (video.kind === "copy") {
    args.push("-map", `0:v:${job.videoIndex}`, "-c:v", "copy");
    if (video.codec === "hevc") args.push("-tag:v", "hvc1");
  } else {
    args.push(...videoFilterArgs(video, job.videoIndex));
    const outputHeight = video.scaleToHeight ?? video.height;
    // One frame per field when deinterlacing: twice the frames per segment.
    const fps = video.fps && video.deinterlace ? video.fps * 2 : video.fps;
    // The first video sample must sit exactly on the keyframe's time (the
    // audio is cut there): no B-frames (decode time = display time), and the
    // source's time base instead of 1/fps, which rounds it by up to half a
    // frame. vfr: with that fine time base, cfr would duplicate frames.
    // prettier-ignore
    args.push(
      ...encoderArgs(video.encoder, outputHeight),
      "-bf", "0",
      "-fps_mode:v", "vfr",
      "-enc_time_base:v", "filter",
      "-g", String(fps ? Math.round(fps * seg) : 250),
      "-force_key_frames", `expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+${seg}))`,
    );
  }

  // Audio
  if (job.audioIndex !== null) {
    args.push("-map", `0:a:${job.audioIndex}`);
    if (video.kind === "copy" && job.audioCopy) {
      args.push("-c:a", "copy");
      // AAC from .ts/.m2ts (and some AVIs) has ADTS headers, which fMP4
      // refuses (ffmpeg exits after the first segment). Raw AAC passes
      // through untouched; any other codec would make the filter fail.
      if (job.audioCodec === "aac") args.push("-bsf:a", "aac_adtstoasc");
    } else {
      // Transcode: always re-encoded, since only decoded audio can be cut
      // at the first video frame (the decoder starts a bit before it).
      // atrim works on the file's own clock, like audioStart.
      if (video.kind === "encode" && job.audioStart !== null) {
        args.push("-af", `atrim=start=${formatSeconds(job.audioStart, 6)}`);
      }
      args.push("-c:a", "aac", "-ac", "2", "-b:a", "192k");
    }
  }

  // HLS output
  // prettier-ignore
  args.push(
    "-avoid_negative_ts", "disabled",
    "-max_muxing_queue_size", "4096",
    ...movieTimeArgs(job.inputStartTime),
    "-f", "hls",
    "-hls_time", String(seg),
    "-hls_segment_type", "fmp4",
    "-hls_playlist_type", "event",
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments+temp_file",
    "-hls_fmp4_init_filename", INIT_FILE,
    "-hls_segment_filename", SEGMENT_TEMPLATE,
    PLAYLIST_FILE,
  );

  // Embedded text subtitles, from the same run (so the times line up).
  for (const n of job.subtitleStreams) {
    // prettier-ignore
    args.push(
      "-map", `0:s:${n}`,
      "-c:s", "webvtt",
      ...movieTimeArgs(job.inputStartTime),
      "-f", "webvtt",
      "-flush_packets", "1",
      subtitleFile(n),
    );
  }

  return args;
}

/**
 * Decodes the first video frame a session starting at `start` will get
 * (same input options, so the same keyframe) and prints its time through
 * the showinfo filter, on the file's own clock (what atrim needs). Cheap:
 * one keyframe is read and decoded.
 */
export function buildFirstFrameProbeArgs(
  input: string,
  start: number,
  videoIndex: number,
): string[] {
  // prettier-ignore
  return [
    "-hide_banner", "-nostdin", "-loglevel", "info",
    ...seekInputArgs(input, start),
    "-map", `0:v:${videoIndex}`,
    "-vf", "showinfo",
    "-frames:v", "1",
    "-f", "null", "-",
  ];
}

/** "[Parsed_showinfo_0 @ …] n:   0 pts:  30000 pts_time:30 …" → 30. */
export function parseShowinfoTime(stderr: string): number | null {
  const match = /\bpts_time:\s*(-?\d+(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) : null;
}

/** The subtitle file formats we convert, and the demuxer that reads each. */
const SUBTITLE_DEMUXERS = {
  srt: "srt",
  vtt: "webvtt",
  ass: "ass",
  ssa: "ass",
} as const;

export type SubtitleFileFormat = keyof typeof SUBTITLE_DEMUXERS;

export function isSubtitleFileFormat(
  extension: string,
): extension is SubtitleFileFormat {
  return Object.hasOwn(SUBTITLE_DEMUXERS, extension);
}

/**
 * Converts a whole subtitle file (our own copy, on disk) to WebVTT on
 * stdout. The demuxer comes from the extension, never from guessing: a
 * ".srt" that's really a DASH manifest must not make ffmpeg fetch URLs.
 */
export function buildSubtitleConvertArgs(
  file: string,
  format: SubtitleFileFormat,
  charset: string | null,
): string[] {
  // prettier-ignore
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-protocol_whitelist", "file",
    // An input option: how to read the file's bytes as text.
    ...(charset ? ["-sub_charenc", charset] : []),
    "-f", SUBTITLE_DEMUXERS[format],
    "-i", file,
    "-map", "0:s:0",
    "-c:s", "webvtt",
    "-f", "webvtt",
    "pipe:1",
  ];
}
