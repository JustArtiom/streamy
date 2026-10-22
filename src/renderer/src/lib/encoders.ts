// The video encoders the engine may use, by their ffmpeg names, with the
// names people know them by. Same names as Settings → Advanced.

const ENCODER_NAMES: Record<string, string> = {
  h264_videotoolbox: "VideoToolbox",
  h264_nvenc: "NVIDIA NVENC",
  h264_qsv: "Intel Quick Sync",
  h264_vaapi: "VA-API",
  h264_amf: "AMD AMF",
  h264_mf: "Media Foundation",
  h264_v4l2m2m: "V4L2",
  libx264: "CPU (x264)",
};

/**
 * What a playback session does with the video (Playback.encoder), for
 * people: "VideoToolbox (graphics card)", "CPU (x264)", "None (copied)".
 * null = direct play: the file itself is played, nothing is encoded.
 */
export function encoderLabel(encoder: string | null): string {
  if (encoder === null) return "None (plays the file itself)";
  if (encoder === "copy") return "None (copied as it is)";
  const name = ENCODER_NAMES[encoder];
  if (!name) return encoder;
  return encoder === "libx264" ? name : `${name} (graphics card)`;
}
