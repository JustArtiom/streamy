import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRuntime } from "../config";
import { useTestRuntime } from "../test/runtime";
import {
  currentEncoder,
  encoderCandidates,
  encoderForNewSession,
  hasFilter,
  resetEncoderForTests,
  testEncodeArgs,
} from "./encoders";

describe("encoderCandidates", () => {
  it("tries the platform's GPU encoders first, libx264 last", () => {
    expect(encoderCandidates("darwin")).toEqual([
      "h264_videotoolbox",
      "libx264",
    ]);
    expect(encoderCandidates("linux")).toEqual([
      "h264_nvenc",
      "h264_qsv",
      "h264_vaapi",
      "libx264",
    ]);
    expect(encoderCandidates("freebsd")).toEqual(["libx264"]);
  });
});

describe("hasFilter", () => {
  it("finds a filter in `ffmpeg -filters`", () => {
    const output = ` .S tonemap           V->V       Conversion to/from different dynamic ranges.
 .S tonemapx          V->V       SIMD optimized HDR to SDR tonemapping
 .. tonemap_opencl    V->V       Perform HDR to SDR conversion with tonemapping.`;
    expect(hasFilter(output, "tonemapx")).toBe(true);
    expect(hasFilter(output, "tonemap")).toBe(true);
    expect(hasFilter(output.replace("tonemapx", "zzz"), "tonemapx")).toBe(
      false,
    );
  });
});

describe("testEncodeArgs", () => {
  it("encodes one black frame to nowhere", () => {
    expect(testEncodeArgs("libx264")).toEqual([
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=black:s=256x144:d=0.2",
      "-vf",
      "format=yuv420p",
      "-frames:v",
      "1",
      "-c:v",
      "libx264",
      "-f",
      "null",
      "-",
    ]);
  });
});

describe('"Hardware video encoding: Off"', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ cleanup } = await useTestRuntime());
    resetEncoderForTests();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("always uses libx264, without waiting for the detection", async () => {
    const runtime = getRuntime();
    runtime.config = { ...runtime.config, hardwareEncoding: "off" };
    // Detection would fail: it isn't even started.
    runtime.ffmpegPath = "/no/such/ffmpeg";

    expect(await encoderForNewSession()).toBe("libx264");
    expect(currentEncoder()).toBe("libx264");
  });

  it("reports null while the detection hasn't finished", () => {
    expect(currentEncoder()).toBeNull();
  });
});
