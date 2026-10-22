import { describe, expect, it } from "vitest";
import type {
  AudioTrack,
  ClientCapabilities,
  MediaInfo,
  SubtitleTrack,
  VideoInfo,
} from "../../shared/engine-api";
import { type DecideInput, decide } from "./decide";

// A typical desktop Chrome: H.264/AAC everywhere, HEVC on some, no 10-bit H.264.
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

const H264: VideoInfo = {
  codec: "h264",
  profile: "High",
  width: 1920,
  height: 1080,
  fps: 24,
  bitDepth: 8,
  hdr: false,
};

function audio(codec: string, index = 0, isDefault = index === 0): AudioTrack {
  return { index, codec, channels: 2, language: null, title: null, isDefault };
}

function subtitle(n: number, codec: string, isText: boolean): SubtitleTrack {
  return {
    id: `embedded:${n}`,
    source: "embedded",
    codec,
    language: null,
    title: null,
    isDefault: false,
    isForced: false,
    isText,
  };
}

const MP4: MediaInfo = {
  duration: 888,
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  bitRate: 2_000_000,
  video: H264,
  audioTracks: [audio("aac")],
  subtitleTracks: [],
};

const MKV: MediaInfo = { ...MP4, container: "matroska,webm" };

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    media: MP4,
    fileName: "Sintel.mp4",
    audioTrack: null,
    quality: "original",
    burnSubtitle: null,
    embeddedSubtitles: false,
    forceMode: null,
    capabilities: CHROME,
    encoder: "h264_videotoolbox",
    ...overrides,
  };
}

function withCaps(
  video: Partial<ClientCapabilities["video"]> = {},
  audioCaps: Partial<ClientCapabilities["audio"]> = {},
  direct: Partial<ClientCapabilities["direct"]> = {},
): ClientCapabilities {
  return {
    video: { ...CHROME.video, ...video },
    audio: { ...CHROME.audio, ...audioCaps },
    direct: { ...CHROME.direct, ...direct },
  };
}

describe("decide", () => {
  it("plays an H.264/AAC MP4 directly", () => {
    const decision = decide(input());
    expect(decision).toMatchObject({
      mode: "direct",
      encoder: null,
      audioTrack: 0,
      output: {
        videoCodec: "h264",
        audioCodec: "aac",
        width: 1920,
        height: 1080,
      },
    });
    expect(decision.reason).toBe("Streamy can play the file as it is");
  });

  it("repackages an MKV (no quality loss)", () => {
    const decision = decide(input({ media: MKV, fileName: "Movie.mkv" }));
    expect(decision.mode).toBe("remux");
    expect(decision.encoder).toBe("copy");
    expect(decision.reason).toBe(
      "MKV isn't playable directly, repackaging it (no quality loss)",
    );
  });

  it("repackages other containers (AVI, TS)", () => {
    const decision = decide(
      input({ media: { ...MP4, container: "avi" }, fileName: "Old.avi" }),
    );
    expect(decision.mode).toBe("remux");
    expect(decision.reason).toContain("AVI isn't playable directly");
  });

  it("plays a VP9/Opus WebM directly", () => {
    const decision = decide(
      input({
        media: {
          ...MKV,
          video: { ...H264, codec: "vp9" },
          audioTracks: [audio("opus")],
        },
        fileName: "clip.webm",
      }),
    );
    expect(decision.mode).toBe("direct");
  });

  it("an MKV named .webm isn't treated as WebM", () => {
    const decision = decide(
      input({
        media: { ...MKV, audioTracks: [audio("aac")] },
        fileName: "x.webm",
      }),
    );
    expect(decision.mode).toBe("remux");
  });

  it("transcodes HEVC when the browser can't decode it", () => {
    const media = { ...MKV, video: { ...H264, codec: "hevc" } };
    const decision = decide(input({ media, fileName: "x.mkv" }));
    expect(decision).toMatchObject({
      mode: "transcode",
      encoder: "h264_videotoolbox",
      reason: "This computer can't decode HEVC, converting to H.264",
      output: { videoCodec: "h264", width: 1920, height: 1080 },
    });
  });

  it("copies HEVC when the browser can decode it", () => {
    const media = { ...MKV, video: { ...H264, codec: "hevc" } };
    const decision = decide(
      input({
        media,
        fileName: "x.mkv",
        capabilities: withCaps({ hevc: true }),
      }),
    );
    expect(decision.mode).toBe("remux");
    expect(decision.output.videoCodec).toBe("hevc");
  });

  it("10-bit HEVC needs hevcMain10, not just hevc", () => {
    const media = { ...MKV, video: { ...H264, codec: "hevc", bitDepth: 10 } };
    expect(
      decide(
        input({
          media,
          fileName: "x.mkv",
          capabilities: withCaps({ hevc: true }),
        }),
      ).mode,
    ).toBe("transcode");
    expect(
      decide(
        input({
          media,
          fileName: "x.mkv",
          capabilities: withCaps({ hevc: true, hevcMain10: true }),
        }),
      ).mode,
    ).toBe("remux");
  });

  it("transcodes 10-bit H.264", () => {
    const media = {
      ...MP4,
      video: { ...H264, bitDepth: 10, profile: "High 10" },
    };
    const decision = decide(input({ media }));
    expect(decision.mode).toBe("transcode");
    expect(decision.reason).toBe(
      "This computer can't decode 10-bit H.264, converting to 8-bit H.264",
    );
  });

  it("transcodes codecs browsers never decode (MPEG-4 Part 2)", () => {
    const media = { ...MKV, video: { ...H264, codec: "mpeg4" } };
    expect(decide(input({ media, fileName: "x.avi" })).reason).toBe(
      "This computer can't decode MPEG-4, converting to H.264",
    );
  });

  it("AC3 audio: remux with the audio converted to AAC", () => {
    const media = { ...MP4, audioTracks: [audio("ac3")] };
    const decision = decide(input({ media }));
    expect(decision).toMatchObject({
      mode: "remux",
      audioCopy: false,
      output: { audioCodec: "aac", videoCodec: "h264" },
    });
    expect(decision.reason).toBe(
      "Streamy can't play AC3 audio, converting the audio (video untouched)",
    );
  });

  it("AC3 in MP4 plays directly when the browser has AC3", () => {
    const media = { ...MP4, audioTracks: [audio("ac3")] };
    const decision = decide(
      input({ media, capabilities: withCaps({}, { ac3: true }) }),
    );
    expect(decision.mode).toBe("direct");
    expect(decision.output.audioCodec).toBe("ac3");
  });

  it("MKV with AC3: says the audio is converted too", () => {
    const media = { ...MKV, audioTracks: [audio("ac3")] };
    const decision = decide(input({ media, fileName: "x.mkv" }));
    expect(decision.reason).toBe(
      "MKV isn't playable directly, repackaging it (no quality loss). AC3 audio is converted to AAC",
    );
  });

  it("another audio track than #0 never plays direct", () => {
    const media = { ...MP4, audioTracks: [audio("aac", 0), audio("aac", 1)] };
    const decision = decide(input({ media, audioTrack: 1 }));
    expect(decision).toMatchObject({
      mode: "remux",
      audioTrack: 1,
      audioCopy: true,
    });
    expect(decision.reason).toBe(
      "Another audio track was chosen, repackaging it (no quality loss)",
    );
  });

  it("no audioTrack = the file's default track", () => {
    const media = {
      ...MP4,
      audioTracks: [audio("aac", 0, false), audio("aac", 1, true)],
    };
    const decision = decide(input({ media }));
    expect(decision.audioTrack).toBe(1);
    expect(decision.mode).toBe("remux");
  });

  it("a file without audio", () => {
    const decision = decide(
      input({ media: { ...MKV, audioTracks: [] }, fileName: "x.mkv" }),
    );
    expect(decision).toMatchObject({
      mode: "remux",
      audioTrack: null,
      output: { audioCodec: "none" },
    });
  });

  it("rejects an audio track that doesn't exist", () => {
    expect(() => decide(input({ audioTrack: 3 }))).toThrow(
      "This audio track doesn't exist",
    );
  });

  it("a quality below the source transcodes and scales", () => {
    const decision = decide(input({ quality: "720p" }));
    expect(decision).toMatchObject({
      mode: "transcode",
      scaleToHeight: 720,
      reason: "Lower quality (720p) requested",
      output: {
        videoCodec: "h264",
        audioCodec: "aac",
        width: 1280,
        height: 720,
      },
    });
  });

  it("transcode re-encodes even AAC audio (it's cut to start with the video)", () => {
    const decision = decide(input({ quality: "480p" }));
    expect(decision).toMatchObject({
      mode: "transcode",
      audioCopy: false,
      output: { audioCodec: "aac" },
    });
    // AAC → AAC isn't worth mentioning; MP3 → AAC is a format change.
    expect(decision.reason).toBe("Lower quality (480p) requested");
    const mp3 = decide(
      input({
        media: { ...MP4, audioTracks: [audio("mp3")] },
        quality: "480p",
      }),
    );
    expect(mp3.reason).toBe(
      "Lower quality (480p) requested. MP3 audio is converted to AAC",
    );
  });

  it("remux copies AAC", () => {
    expect(decide(input({ media: MKV, fileName: "x.mkv" })).audioCopy).toBe(
      true,
    );
  });

  it("a quality at or above the source is the original", () => {
    expect(decide(input({ quality: "1080p" })).mode).toBe("direct");
    const small = { ...MP4, video: { ...H264, width: 1280, height: 720 } };
    const decision = decide(input({ media: small, quality: "1080p" }));
    expect(decision.mode).toBe("direct");
    expect(decision.scaleToHeight).toBeNull();
  });

  it("burning in a picture subtitle transcodes", () => {
    const media = {
      ...MKV,
      subtitleTracks: [
        subtitle(0, "subrip", true),
        subtitle(1, "hdmv_pgs_subtitle", false),
      ],
    };
    const decision = decide(
      input({ media, fileName: "x.mkv", burnSubtitle: "embedded:1" }),
    );
    expect(decision).toMatchObject({
      mode: "transcode",
      burnSubtitle: 1,
      reason: "Burning in picture subtitles",
    });
  });

  it("only picture subtitles can be burned in", () => {
    const media = { ...MKV, subtitleTracks: [subtitle(0, "subrip", true)] };
    expect(() => decide(input({ media, burnSubtitle: "embedded:0" }))).toThrow(
      /only picture subtitles/,
    );
    expect(() => decide(input({ media, burnSubtitle: "embedded:5" }))).toThrow(
      "This subtitle track doesn't exist",
    );
  });

  it("several reasons to transcode are all given", () => {
    const media = {
      ...MKV,
      video: { ...H264, codec: "hevc" },
      subtitleTracks: [subtitle(0, "dvd_subtitle", false)],
    };
    const decision = decide(
      input({
        media,
        fileName: "x.mkv",
        burnSubtitle: "embedded:0",
        quality: "480p",
      }),
    );
    expect(decision.reason).toBe(
      "This computer can't decode HEVC, converting to H.264. Burning in picture subtitles. Lower quality (480p) requested",
    );
    expect(decision.output).toMatchObject({ width: 854, height: 480 });
  });

  it("embeddedSubtitles turns direct into remux", () => {
    const media = { ...MP4, subtitleTracks: [subtitle(0, "mov_text", true)] };
    const decision = decide(input({ media, embeddedSubtitles: true }));
    expect(decision.mode).toBe("remux");
    expect(decision.reason).toBe(
      "Repackaging to read the embedded subtitles (no quality loss)",
    );
  });

  it("a browser that can't play MP4 progressively gets remux", () => {
    const decision = decide(
      input({ capabilities: withCaps({}, {}, { mp4: false }) }),
    );
    expect(decision.mode).toBe("remux");
    expect(decision.reason).toContain("can't play MP4 files directly");
  });

  describe("forceMode", () => {
    it("remux after direct failed", () => {
      const decision = decide(input({ forceMode: "remux" }));
      expect(decision.mode).toBe("remux");
      expect(decision.reason).toBe("Repackaging as asked (no quality loss)");
    });

    it("transcode after remux failed", () => {
      const decision = decide(input({ forceMode: "transcode" }));
      expect(decision).toMatchObject({
        mode: "transcode",
        reason: "Converting the video to H.264 as asked",
        scaleToHeight: null,
        output: { width: 1920, height: 1080 },
      });
    });

    it("direct on an MKV the browser might manage", () => {
      const decision = decide(
        input({ media: MKV, fileName: "x.mkv", forceMode: "direct" }),
      );
      expect(decision.mode).toBe("direct");
    });

    it("direct/remux become transcode when the video can't be copied", () => {
      const media = { ...MKV, video: { ...H264, codec: "hevc" } };
      expect(decide(input({ media, forceMode: "direct" })).mode).toBe(
        "transcode",
      );
      expect(decide(input({ media, forceMode: "remux" })).mode).toBe(
        "transcode",
      );
      expect(decide(input({ forceMode: "remux", quality: "480p" })).mode).toBe(
        "transcode",
      );
    });
  });

  it("keeps odd source sizes even when transcoding", () => {
    const media = {
      ...MKV,
      video: { ...H264, codec: "hevc", width: 1279, height: 533 },
    };
    expect(decide(input({ media })).output).toMatchObject({
      width: 1278,
      height: 532,
    });
  });
});
