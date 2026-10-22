import { describe, expect, it, vi } from "vitest";
import { type CapabilityChecks, detectCapabilities } from "@/lib/capabilities";

/** A browser that supports exactly these MediaSource / canPlayType strings. */
function browser({
  mse,
  native = [],
}: {
  mse: string[] | null;
  native?: string[];
}): CapabilityChecks {
  return {
    isTypeSupported: mse ? (type) => mse.includes(type) : null,
    canPlayType: (type) => (native.includes(type) ? "probably" : ""),
  };
}

const CHROME_MSE = [
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="av01.0.08M.08"',
  'video/mp4; codecs="vp09.00.40.08"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="mp4a.69"',
  'audio/mp4; codecs="opus"',
  'audio/mp4; codecs="flac"',
];

describe("detectCapabilities", () => {
  it("asks MediaSource with the exact type strings", () => {
    const caps = detectCapabilities(browser({ mse: CHROME_MSE }));

    expect(caps.video).toEqual({
      h264: true,
      h264High10: false,
      hevc: false,
      hevcMain10: false,
      av1: true,
      vp9: true,
    });
    expect(caps.audio).toEqual({
      aac: true,
      mp3: true,
      opus: true,
      flac: true,
      ac3: false,
      eac3: false,
    });
  });

  it("checks each flag's own type string", () => {
    const flags: [
      string,
      (c: ReturnType<typeof detectCapabilities>) => boolean,
    ][] = [
      ['video/mp4; codecs="avc1.6e0028"', (c) => c.video.h264High10],
      ['video/mp4; codecs="hvc1.1.6.L120.90"', (c) => c.video.hevc],
      ['video/mp4; codecs="hvc1.2.4.L120.90"', (c) => c.video.hevcMain10],
      ['audio/mp4; codecs="ac-3"', (c) => c.audio.ac3],
      ['audio/mp4; codecs="ec-3"', (c) => c.audio.eac3],
    ];
    for (const [type, flag] of flags) {
      expect(flag(detectCapabilities(browser({ mse: [type] })))).toBe(true);
      expect(flag(detectCapabilities(browser({ mse: [] })))).toBe(false);
    }
  });

  it("counts mp3 when either type works", () => {
    expect(
      detectCapabilities(browser({ mse: ['audio/mp4; codecs="mp4a.69"'] }))
        .audio.mp3,
    ).toBe(true);
    expect(detectCapabilities(browser({ mse: ["audio/mpeg"] })).audio.mp3).toBe(
      true,
    );
    expect(detectCapabilities(browser({ mse: [] })).audio.mp3).toBe(false);
  });

  it("decides direct play with canPlayType, not MediaSource", () => {
    const caps = detectCapabilities(
      browser({
        mse: CHROME_MSE,
        native: ['video/mp4; codecs="avc1.640028, mp4a.40.2"'],
      }),
    );
    expect(caps.direct).toEqual({ mp4: true, webm: false });

    const webm = detectCapabilities(
      browser({ mse: [], native: ['video/webm; codecs="vp9, opus"'] }),
    );
    expect(webm.direct).toEqual({ mp4: false, webm: true });
  });

  it("lets canPlayType answer everything without MediaSource (iPhone)", () => {
    const caps = detectCapabilities(
      browser({
        mse: null,
        native: [
          'video/mp4; codecs="avc1.640028"',
          'video/mp4; codecs="hvc1.1.6.L120.90"',
          'audio/mp4; codecs="mp4a.40.2"',
          'audio/mp4; codecs="ec-3"',
          'video/mp4; codecs="avc1.640028, mp4a.40.2"',
        ],
      }),
    );

    expect(caps.video.h264).toBe(true);
    expect(caps.video.hevc).toBe(true);
    expect(caps.video.av1).toBe(false);
    expect(caps.audio.aac).toBe(true);
    expect(caps.audio.eac3).toBe(true);
    expect(caps.audio.opus).toBe(false);
    expect(caps.direct.mp4).toBe(true);
  });

  it("treats a check that throws as unsupported", () => {
    const caps = detectCapabilities({
      isTypeSupported: vi.fn(() => {
        throw new Error("nope");
      }),
      canPlayType: () => {
        throw new Error("nope");
      },
    });
    expect(caps.video.h264).toBe(false);
    expect(caps.direct.mp4).toBe(false);
  });

  it("canPlayType 'maybe' counts as yes", () => {
    const caps = detectCapabilities({
      isTypeSupported: null,
      canPlayType: () => "maybe",
    });
    expect(caps.video.h264).toBe(true);
    expect(caps.direct.webm).toBe(true);
  });
});
