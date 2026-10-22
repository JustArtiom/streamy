import { describe, expect, it } from "vitest";
import { encoderLabel } from "@/lib/encoders";

describe("encoderLabel", () => {
  it("names hardware encoders and the CPU one", () => {
    expect(encoderLabel("h264_videotoolbox")).toBe(
      "VideoToolbox (graphics card)",
    );
    expect(encoderLabel("h264_nvenc")).toBe("NVIDIA NVENC (graphics card)");
    expect(encoderLabel("libx264")).toBe("CPU (x264)");
  });

  it("says when nothing is encoded", () => {
    expect(encoderLabel("copy")).toBe("None (copied as it is)");
    expect(encoderLabel(null)).toBe("None (plays the file itself)");
  });

  it("shows encoders it doesn't know as they are", () => {
    expect(encoderLabel("h264_rkmpp")).toBe("h264_rkmpp");
  });
});
