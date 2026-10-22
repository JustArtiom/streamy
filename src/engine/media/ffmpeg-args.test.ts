import { describe, expect, it } from "vitest";
import {
  buildSessionArgs,
  buildFirstFrameProbeArgs,
  buildSubtitleConvertArgs,
  encoderArgs,
  isSubtitleFileFormat,
  parseShowinfoTime,
  seekInputArgs,
  type SessionJob,
  toneMapFilter,
  torrentInputArgs,
  videoBitrateKbps,
  videoFilterChain,
} from "./ffmpeg-args";

const URL = "http://127.0.0.1:3000/internal/files/abc";

const INPUT_OPTIONS = [
  "-format_whitelist",
  "matroska,mov,mpegts,mpeg,mpegvideo,avi,flv,asf,ogg",
  "-protocol_whitelist",
  "http,tcp",
  "-reconnect",
  "1",
  "-reconnect_on_network_error",
  "1",
  "-reconnect_delay_max",
  "7",
];

const HLS_OUTPUT = [
  "-avoid_negative_ts",
  "disabled",
  "-max_muxing_queue_size",
  "4096",
  "-f",
  "hls",
  "-hls_time",
  "4",
  "-hls_segment_type",
  "fmp4",
  "-hls_playlist_type",
  "event",
  "-hls_list_size",
  "0",
  "-hls_flags",
  "independent_segments+temp_file",
  "-hls_fmp4_init_filename",
  "init.mp4",
  "-hls_segment_filename",
  "seg_%05d.m4s",
  "index.m3u8",
];

const REMUX: SessionJob = {
  input: URL,
  start: 23,
  inputStartTime: 0,
  segmentSeconds: 4,
  videoIndex: 0,
  audioIndex: 1,
  audioCodec: "ac3",
  audioCopy: false,
  audioStart: null,
  video: { kind: "copy", codec: "h264" },
  subtitleStreams: [],
};

const ENCODE = {
  kind: "encode",
  encoder: "h264_videotoolbox",
  fps: 24,
  hdr: null,
  toneMapper: "tonemapx",
  deinterlace: false,
  width: 1920,
  height: 1080,
  scaleToHeight: 480,
  burnSubtitle: null,
} as const;

/** The value after a flag. */
function valueOf(args: string[], flag: string) {
  return args[args.indexOf(flag) + 1];
}

describe("buildSessionArgs", () => {
  it("remux: copy video, convert audio, every stream from the keyframe before start", () => {
    expect(buildSessionArgs(REMUX)).toEqual([
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "warning",
      "-y",
      ...INPUT_OPTIONS,
      "-copyts",
      "-noaccurate_seek",
      "-ss",
      "23",
      "-i",
      URL,
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-map",
      "0:a:1",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-b:a",
      "192k",
      ...HLS_OUTPUT,
    ]);
  });

  it("no -ss at the start, -c:a copy for AAC, no audio map without audio", () => {
    const args = buildSessionArgs({
      ...REMUX,
      start: 0,
      audioCopy: true,
      audioCodec: "aac",
    });
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-noaccurate_seek");
    expect(valueOf(args, "-c:a")).toBe("copy");

    const silent = buildSessionArgs({ ...REMUX, audioIndex: null });
    expect(silent).not.toContain("0:a:1");
    expect(silent).not.toContain("-c:a");
  });

  it("copied AAC goes through aac_adtstoasc (ADTS from .ts), other codecs don't", () => {
    const aac = buildSessionArgs({
      ...REMUX,
      audioCopy: true,
      audioCodec: "aac",
    });
    expect(valueOf(aac, "-bsf:a")).toBe("aac_adtstoasc");
    expect(aac.indexOf("-bsf:a")).toBeGreaterThan(aac.indexOf("-c:a"));

    // The filter refuses anything but AAC (ffmpeg wouldn't start).
    const mp3 = buildSessionArgs({
      ...REMUX,
      audioCopy: true,
      audioCodec: "mp3",
    });
    expect(valueOf(mp3, "-c:a")).toBe("copy");
    expect(mp3).not.toContain("-bsf:a");

    // Converted audio needs none.
    expect(buildSessionArgs({ ...REMUX, audioCodec: "aac" })).not.toContain(
      "-bsf:a",
    );
  });

  it("shifts every output by -start_time onto the movie timeline", () => {
    const args = buildSessionArgs({
      ...REMUX,
      inputStartTime: 1001.376778,
      subtitleStreams: [0],
    });
    // -ss stays a movie time: ffmpeg counts it from start_time.
    expect(valueOf(args, "-ss")).toBe("23");
    const hls = args.indexOf("hls");
    const vtt = args.lastIndexOf("webvtt");
    const shifts = args.flatMap((arg, i) =>
      arg === "-output_ts_offset" ? [i] : [],
    );
    expect(shifts).toHaveLength(2);
    expect(args[(shifts[0] ?? 0) + 1]).toBe("-1001.376778");
    expect(args[(shifts[1] ?? 0) + 1]).toBe("-1001.376778");
    expect(shifts[0]).toBeLessThan(hls);
    expect(shifts[1]).toBeGreaterThan(hls);
    expect(shifts[1]).toBeLessThan(vtt);

    expect(buildSessionArgs(REMUX)).not.toContain("-output_ts_offset");
  });

  it("tags copied HEVC as hvc1", () => {
    const args = buildSessionArgs({
      ...REMUX,
      video: { kind: "copy", codec: "hevc" },
    });
    expect(valueOf(args, "-tag:v")).toBe("hvc1");
  });

  it("maps the real video stream (not cover art)", () => {
    expect(buildSessionArgs({ ...REMUX, videoIndex: 1 })).toContain("0:v:1");
  });

  it("transcode: scale, encoder, -g and -force_key_frames every SEG", () => {
    const args = buildSessionArgs({ ...REMUX, start: 23.5, video: ENCODE });
    expect(valueOf(args, "-ss")).toBe("23.5");
    expect(valueOf(args, "-vf")).toBe("scale=-2:480,format=yuv420p");
    expect(valueOf(args, "-c:v")).toBe("h264_videotoolbox");
    expect(valueOf(args, "-b:v")).toBe("1500k");
    expect(valueOf(args, "-g")).toBe("96");
    expect(valueOf(args, "-force_key_frames")).toBe(
      "expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+4))",
    );
    // The first video sample exactly at the keyframe's time.
    expect(valueOf(args, "-bf")).toBe("0");
    expect(valueOf(args, "-fps_mode:v")).toBe("vfr");
    expect(valueOf(args, "-enc_time_base:v")).toBe("filter");
    // The HLS output comes after every video/audio option.
    expect(args.slice(-HLS_OUTPUT.length)).toEqual(HLS_OUTPUT);
  });

  it("transcode re-encodes the audio, cut at the first video frame", () => {
    const args = buildSessionArgs({
      ...REMUX,
      audioCopy: true,
      audioStart: 19.916667,
      video: ENCODE,
    });
    expect(valueOf(args, "-af")).toBe("atrim=start=19.916667");
    expect(valueOf(args, "-c:a")).toBe("aac");
    expect(args.indexOf("-af")).toBeGreaterThan(args.indexOf("0:a:1"));

    const uncut = buildSessionArgs({ ...REMUX, video: ENCODE });
    expect(uncut).not.toContain("-af");
    expect(valueOf(uncut, "-c:a")).toBe("aac");
  });

  it("remux never cuts the audio", () => {
    const args = buildSessionArgs({ ...REMUX, audioStart: 20 });
    expect(args).not.toContain("-af");
  });

  it("-g falls back to 250 when the frame rate is unknown", () => {
    const args = buildSessionArgs({
      ...REMUX,
      video: { ...ENCODE, fps: null },
    });
    expect(valueOf(args, "-g")).toBe("250");
  });

  it("burn-in scales the subtitle's canvas to the video, overlays it, maps [v]", () => {
    const args = buildSessionArgs({
      ...REMUX,
      videoIndex: 0,
      video: { ...ENCODE, scaleToHeight: null, burnSubtitle: 2 },
    });
    expect(valueOf(args, "-filter_complex")).toBe(
      "[0:s:2]scale=1920:1080[sub];[0:v:0][sub]overlay=eof_action=pass,format=yuv420p[v]",
    );
    expect(valueOf(args, "-map")).toBe("[v]");
    expect(args).not.toContain("-vf");
  });

  it("deinterlaces interlaced video first (one frame per field: double -g)", () => {
    const args = buildSessionArgs({
      ...REMUX,
      video: { ...ENCODE, fps: 25, deinterlace: true },
    });
    expect(valueOf(args, "-vf")).toBe(
      "bwdif=mode=send_field:deint=interlaced,scale=-2:480,format=yuv420p",
    );
    expect(valueOf(args, "-g")).toBe("200");

    const burned = buildSessionArgs({
      ...REMUX,
      video: { ...ENCODE, deinterlace: true, burnSubtitle: 0 },
    });
    expect(valueOf(burned, "-filter_complex")).toBe(
      "[0:s:0]scale=1920:1080[sub];[0:v:0]bwdif=mode=send_field:deint=interlaced[main];[main][sub]overlay=eof_action=pass,scale=-2:480,format=yuv420p[v]",
    );
  });

  it("adds one WebVTT output per embedded text subtitle, after the HLS output", () => {
    const args = buildSessionArgs({ ...REMUX, subtitleStreams: [0, 3] });
    const afterHls = args.slice(args.indexOf("index.m3u8") + 1);
    expect(afterHls).toEqual([
      "-map",
      "0:s:0",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "-flush_packets",
      "1",
      "sub_0.vtt",
      "-map",
      "0:s:3",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "-flush_packets",
      "1",
      "sub_3.vtt",
    ]);
  });

  it("never uses -progress or -readrate", () => {
    const args = buildSessionArgs({
      ...REMUX,
      video: ENCODE,
      subtitleStreams: [0],
    });
    expect(args).not.toContain("-progress");
    expect(args).not.toContain("-readrate");
  });

  it("writes only relative names (a % in the folder's path can't break them)", () => {
    const args = buildSessionArgs({ ...REMUX, subtitleStreams: [1] });
    for (const arg of args.filter((a) => /\.(m3u8|m4s|mp4|vtt)$/.test(a))) {
      expect(arg).not.toContain("/");
    }
  });

  it("VAAPI gets its device before the input and uploads frames", () => {
    const args = buildSessionArgs({
      ...REMUX,
      video: { ...ENCODE, encoder: "h264_vaapi" },
    });
    expect(args.indexOf("-vaapi_device")).toBeLessThan(args.indexOf("-i"));
    expect(valueOf(args, "-vf")).toBe("scale=-2:480,format=nv12,hwupload");
  });
});

describe("videoFilterChain", () => {
  it("tone-maps HDR after scaling, with tonemapx when ffmpeg has it", () => {
    expect(
      videoFilterChain({ ...ENCODE, hdr: "smpte2084", scaleToHeight: 720 }),
    ).toBe(
      "scale=-2:720,tonemapx=tonemap=bt2390:t=bt709:m=bt709:p=bt709:format=yuv420p,format=yuv420p",
    );
  });

  it("falls back to zscale with every input property spelled out", () => {
    expect(
      videoFilterChain({
        ...ENCODE,
        hdr: "arib-std-b67",
        toneMapper: "zscale",
        scaleToHeight: null,
      }),
    ).toBe(
      "zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=tv:t=linear:p=bt2020:m=bt2020nc:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p",
    );
  });

  it("evens out odd sizes when not scaling", () => {
    expect(
      videoFilterChain({
        ...ENCODE,
        scaleToHeight: null,
        width: 1279,
        height: 533,
      }),
    ).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p");
    expect(videoFilterChain({ ...ENCODE, scaleToHeight: null })).toBe(
      "format=yuv420p",
    );
  });
});

describe("toneMapFilter", () => {
  it("hands QSV and VAAPI nv12", () => {
    expect(toneMapFilter("smpte2084", "tonemapx", "h264_qsv")).toContain(
      "format=nv12",
    );
    expect(toneMapFilter("smpte2084", "tonemapx", "libx264")).toContain(
      "format=yuv420p",
    );
  });
});

describe("encoderArgs", () => {
  it("libx264", () => {
    expect(encoderArgs("libx264", 1080)).toEqual([
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-maxrate",
      "7980k",
      "-bufsize",
      "12000k",
      "-profile:v",
      "high",
      "-level:v",
      "4.1",
      "-sc_threshold",
      "0",
    ]);
    expect(valueOf(encoderArgs("libx264", 2160), "-level:v")).toBe("5.1");
  });

  it("h264_videotoolbox", () => {
    expect(encoderArgs("h264_videotoolbox", 720)).toEqual([
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      "3000k",
      "-maxrate",
      "3990k",
      "-bufsize",
      "6000k",
      "-profile:v",
      "high",
      "-allow_sw",
      "1",
    ]);
  });

  it("h264_nvenc", () => {
    expect(encoderArgs("h264_nvenc", 480)).toEqual([
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p4",
      "-rc",
      "vbr",
      "-b:v",
      "1500k",
      "-maxrate",
      "1995k",
      "-bufsize",
      "3000k",
      "-profile:v",
      "high",
      "-forced-idr",
      "1",
    ]);
  });

  it("h264_qsv makes its forced keyframes IDR frames", () => {
    expect(valueOf(encoderArgs("h264_qsv", 720), "-forced_idr")).toBe("1");
    expect(encoderArgs("h264_vaapi", 720)).not.toContain("-forced_idr");
  });
});

describe("videoBitrateKbps", () => {
  it.each([
    [2160, 16_000],
    [1440, 10_000],
    [1080, 6_000],
    [720, 3_000],
    [480, 1_500],
    [360, 800],
  ])("%ip → %i kbit/s", (height, kbps) => {
    expect(videoBitrateKbps(height)).toBe(kbps);
  });
});

describe("seekInputArgs", () => {
  it("seeks every stream to the same keyframe, keeping real timestamps", () => {
    expect(seekInputArgs(URL, 47.3)).toEqual([
      ...INPUT_OPTIONS,
      "-copyts",
      "-noaccurate_seek",
      "-ss",
      "47.3",
      "-i",
      URL,
    ]);
    expect(seekInputArgs(URL, 0)).toEqual([
      ...INPUT_OPTIONS,
      "-copyts",
      "-i",
      URL,
    ]);
  });
});

describe("torrentInputArgs", () => {
  it("allows real containers only (never playlists), over http only", () => {
    const args = torrentInputArgs();
    const formats = valueOf(args, "-format_whitelist")?.split(",") ?? [];
    for (const playlist of ["hls", "dash", "concat", "sdp", "rtsp", "image2"]) {
      expect(formats).not.toContain(playlist);
    }
    expect(formats).toEqual(
      expect.arrayContaining(["matroska", "mov", "mpegts", "avi", "asf"]),
    );
    expect(valueOf(args, "-protocol_whitelist")).toBe("http,tcp");
  });
});

describe("buildFirstFrameProbeArgs", () => {
  it("uses the session's own input options and prints the first frame", () => {
    const args = buildFirstFrameProbeArgs(URL, 47.3, 1);
    const input = seekInputArgs(URL, 47.3);
    const at = args.indexOf("-format_whitelist");
    expect(args.slice(at, at + input.length)).toEqual(input);
    expect(args).toEqual(
      expect.arrayContaining([
        "-map",
        "0:v:1",
        "-vf",
        "showinfo",
        "-frames:v",
        "1",
      ]),
    );
    expect(valueOf(args, "-loglevel")).toBe("info");
  });
});

describe("parseShowinfoTime", () => {
  it("reads pts_time from the showinfo line", () => {
    const stderr = `Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> wrapped_avframe (native))
[Parsed_showinfo_0 @ 0x6000] n:   0 pts:  30000 pts_time:30      duration:     42 duration_time:0.042 fmt:yuv420p
[Parsed_showinfo_0 @ 0x6000] n:   1 pts:  30042 pts_time:30.042  duration:     42`;
    expect(parseShowinfoTime(stderr)).toBe(30);
    expect(parseShowinfoTime("... pts_time:39.916667 ...")).toBe(39.916667);
    expect(parseShowinfoTime("no frame")).toBeNull();
  });
});

describe("buildSubtitleConvertArgs", () => {
  it("passes -sub_charenc before the input only when needed", () => {
    expect(buildSubtitleConvertArgs("/s/1.srt", "srt", "windows-1251")).toEqual(
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-sub_charenc",
        "windows-1251",
        "-f",
        "srt",
        "-i",
        "/s/1.srt",
        "-map",
        "0:s:0",
        "-c:s",
        "webvtt",
        "-f",
        "webvtt",
        "pipe:1",
      ],
    );
    expect(buildSubtitleConvertArgs("/s/1.srt", "srt", null)).not.toContain(
      "-sub_charenc",
    );
  });

  it("forces the demuxer from the extension (never guessed)", () => {
    const demuxer = (format: "srt" | "vtt" | "ass" | "ssa") =>
      valueOf(buildSubtitleConvertArgs("/s/1", format, null), "-f");
    expect(demuxer("srt")).toBe("srt");
    expect(demuxer("vtt")).toBe("webvtt");
    expect(demuxer("ass")).toBe("ass");
    expect(demuxer("ssa")).toBe("ass");
    expect(isSubtitleFileFormat("ssa")).toBe(true);
    expect(isSubtitleFileFormat("mpd")).toBe(false);
    expect(isSubtitleFileFormat("toString")).toBe(false);
  });
});
