import { getRuntime } from "../config";
import { logger } from "../lib/logger";
import type { ToneMapper } from "./ffmpeg-args";
import { runProcess } from "./run";

/*
 * Which H.264 encoder transcoding uses. A GPU encoder is several times
 * faster than libx264 (CPU), but only works if the hardware and the ffmpeg
 * build support it, so each one is tried with a one-frame test encode.
 */

export type VideoEncoder =
  "libx264" | "h264_videotoolbox" | "h264_nvenc" | "h264_qsv" | "h264_vaapi";

const log = logger.child({ module: "encoders" });

/** GPU encoders worth trying on this OS, best first, then the CPU one. */
export function encoderCandidates(platform: NodeJS.Platform): VideoEncoder[] {
  if (platform === "darwin") return ["h264_videotoolbox", "libx264"];
  if (platform === "linux") {
    return ["h264_nvenc", "h264_qsv", "h264_vaapi", "libx264"];
  }
  if (platform === "win32") return ["h264_nvenc", "h264_qsv", "libx264"];
  return ["libx264"];
}

/** VAAPI needs a device and frames uploaded to the GPU; the others take plain frames. */
export function hardwareInputArgs(encoder: VideoEncoder): string[] {
  return encoder === "h264_vaapi"
    ? ["-vaapi_device", "/dev/dri/renderD128"]
    : [];
}

/** The last filter of every video chain: the pixel format the encoder wants. */
export function outputPixelFormatFilter(encoder: VideoEncoder): string {
  if (encoder === "h264_vaapi") return "format=nv12,hwupload";
  if (encoder === "h264_qsv") return "format=nv12";
  return "format=yuv420p";
}

export function testEncodeArgs(encoder: VideoEncoder): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    ...hardwareInputArgs(encoder),
    "-f",
    "lavfi",
    "-i",
    "color=black:s=256x144:d=0.2",
    "-vf",
    outputPixelFormatFilter(encoder),
    "-frames:v",
    "1",
    "-c:v",
    encoder,
    "-f",
    "null",
    "-",
  ];
}

async function detect(): Promise<VideoEncoder> {
  for (const encoder of encoderCandidates(process.platform)) {
    const result = await runProcess(
      getRuntime().ffmpegPath,
      testEncodeArgs(encoder),
      { timeoutMs: 15_000 },
    );
    if (result.code === 0) {
      log.info({ encoder }, "Video encoder chosen");
      return encoder;
    }
    log.debug({ encoder, stderr: result.stderr }, "Video encoder unavailable");
  }

  // Even libx264 failed its test. Use it anyway: the error will show up
  // (and be logged) when a transcode runs.
  log.warn("No video encoder passed the test encode, using libx264");
  return "libx264";
}

/** "… .S tonemapx  V->V  SIMD optimized HDR to SDR tonemapping" → it's there. */
export function hasFilter(filtersOutput: string, name: string): boolean {
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(filtersOutput);
}

/**
 * jellyfin-ffmpeg's tonemapx is ~3× faster than zscale + tonemap (4K HDR
 * transcodes in real time) and copes with untagged colours. Any other
 * ffmpeg build falls back to zscale.
 */
async function detectToneMapper(): Promise<ToneMapper> {
  const result = await runProcess(
    getRuntime().ffmpegPath,
    ["-hide_banner", "-filters"],
    { timeoutMs: 15_000 },
  );
  const toneMapper =
    result.code === 0 && hasFilter(result.stdout.toString("utf8"), "tonemapx")
      ? "tonemapx"
      : "zscale";
  log.info({ toneMapper }, "HDR tone mapper chosen");
  return toneMapper;
}

let toneMapper: Promise<ToneMapper> | null = null;

/** How transcodes tone-map HDR, detected once (a missing ffmpeg isn't cached). */
export function getToneMapper(): Promise<ToneMapper> {
  toneMapper ??= detectToneMapper().catch((error: unknown) => {
    toneMapper = null;
    throw error;
  });
  return toneMapper;
}

let cached: Promise<VideoEncoder> | null = null;
/** The detected encoder once known (for /v1/health). */
let detected: VideoEncoder | null = null;

/**
 * The best encoder this computer has, detected once (the engine starts it
 * in the background at launch, which also detects the tone mapper). A
 * missing ffmpeg isn't cached, so a retry can work.
 */
export function getVideoEncoder(): Promise<VideoEncoder> {
  if (!cached) {
    // Alongside, in the background: what HDR transcodes will need.
    getToneMapper().catch((err: unknown) => {
      log.warn({ err }, "Couldn't list ffmpeg's filters");
    });
    cached = detect().then(
      (encoder) => {
        detected = encoder;
        return encoder;
      },
      (error: unknown) => {
        cached = null;
        throw error;
      },
    );
  }
  return cached;
}

/**
 * The encoder new transcodes use: the setting "Hardware video encoding:
 * Off" means always libx264 (CPU), whatever the detection found.
 */
export async function encoderForNewSession(): Promise<VideoEncoder> {
  if (getRuntime().config.hardwareEncoding === "off") return "libx264";
  return getVideoEncoder();
}

/** What /v1/health reports: null while detection still runs (or failed). */
export function currentEncoder(): VideoEncoder | null {
  if (getRuntime().config.hardwareEncoding === "off") return "libx264";
  return detected;
}

/** Tests. */
export function resetEncoderForTests(): void {
  cached = null;
  detected = null;
  toneMapper = null;
}
