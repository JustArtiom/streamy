import { describe, expect, it } from "vitest";
import {
  bitDepthOf,
  parseFrameRate,
  type ProbeOutput,
  toProbedMedia,
} from "./probe";

const PROBE: ProbeOutput = {
  format: {
    format_name: "matroska,webm",
    duration: "60.023000",
    bit_rate: "1231449.5",
  },
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "mjpeg",
      disposition: { attached_pic: 1 },
    },
    {
      index: 1,
      codec_type: "video",
      codec_name: "hevc",
      profile: "Main 10",
      width: 3840,
      height: 2160,
      avg_frame_rate: "24000/1001",
      pix_fmt: "yuv420p10le",
      color_transfer: "smpte2084",
      disposition: { default: 1 },
    },
    {
      index: 2,
      codec_type: "audio",
      codec_name: "eac3",
      channels: 6,
      tags: { language: "eng", title: "Surround 5.1" },
      disposition: { default: 1 },
    },
    {
      index: 3,
      codec_type: "audio",
      codec_name: "aac",
      channels: 2,
      tags: { language: "rus" },
      disposition: { default: 0 },
    },
    {
      index: 4,
      codec_type: "subtitle",
      codec_name: "subrip",
      tags: { language: "spa" },
      disposition: { forced: 1 },
    },
    {
      index: 5,
      codec_type: "subtitle",
      codec_name: "hdmv_pgs_subtitle",
      tags: { language: "und" },
    },
  ],
};

describe("toProbedMedia", () => {
  it("maps ffprobe JSON to MediaInfo, skipping cover art", () => {
    expect(toProbedMedia(PROBE)).toEqual({
      videoIndex: 1,
      startTime: 0,
      hdrTransfer: "smpte2084",
      interlaced: false,
      info: {
        duration: 60.023,
        container: "matroska,webm",
        bitRate: 1231450,
        video: {
          codec: "hevc",
          profile: "Main 10",
          width: 3840,
          height: 2160,
          fps: 23.976,
          bitDepth: 10,
          hdr: true,
        },
        audioTracks: [
          {
            index: 0,
            codec: "eac3",
            channels: 6,
            language: "en",
            title: "Surround 5.1",
            isDefault: true,
          },
          {
            index: 1,
            codec: "aac",
            channels: 2,
            language: "ru",
            title: null,
            isDefault: false,
          },
        ],
        subtitleTracks: [
          {
            id: "embedded:0",
            source: "embedded",
            codec: "subrip",
            language: "es",
            title: null,
            isDefault: false,
            isForced: true,
            isText: true,
          },
          {
            id: "embedded:1",
            source: "embedded",
            codec: "hdmv_pgs_subtitle",
            language: null,
            title: null,
            isDefault: false,
            isForced: false,
            isText: false,
          },
        ],
      },
    });
  });

  it("keeps the file's start time, and spots interlaced video", () => {
    const probed = toProbedMedia({
      format: { format_name: "mpegts", start_time: "1001.376778" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          field_order: "tt",
          color_transfer: "bt709",
        },
      ],
    });
    expect(probed).toMatchObject({
      startTime: 1001.376778,
      interlaced: true,
      hdrTransfer: null,
    });
    expect(probed.info.video?.hdr).toBe(false);
  });

  it("throws 400 when there's no video", () => {
    expect(() =>
      toProbedMedia({
        format: { format_name: "mp3" },
        streams: [{ index: 0, codec_type: "audio", codec_name: "mp3" }],
      }),
    ).toThrow("This file has no video");
  });
});

describe("parseFrameRate", () => {
  it.each([
    ["24/1", 24],
    ["30000/1001", 29.97],
    ["0/0", null],
    [undefined, null],
  ])("%s → %s", (rate, fps) => {
    expect(parseFrameRate(rate)).toBe(fps);
  });
});

describe("bitDepthOf", () => {
  it("prefers bits_per_raw_sample, then the pixel format", () => {
    expect(bitDepthOf({ index: 0, bits_per_raw_sample: "10" })).toBe(10);
    expect(bitDepthOf({ index: 0, pix_fmt: "yuv420p10le" })).toBe(10);
    expect(bitDepthOf({ index: 0, pix_fmt: "yuv420p12be" })).toBe(12);
    expect(bitDepthOf({ index: 0, pix_fmt: "yuv420p" })).toBe(8);
  });
});
