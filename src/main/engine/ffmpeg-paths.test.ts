import { describe, expect, it } from "vitest";
import { findFfmpeg } from "./ffmpeg-paths";

const base = {
  isPackaged: false,
  resourcesPath: "/Applications/Streamy.app/Contents/Resources",
  appPath: "/src/streamy/app",
  platform: "darwin" as NodeJS.Platform,
  arch: "arm64",
  env: {},
  exists: () => true,
};

describe("findFfmpeg", () => {
  it("uses the copies bundled with the installed app", () => {
    expect(findFfmpeg({ ...base, isPackaged: true })).toEqual({
      ffmpegPath: "/Applications/Streamy.app/Contents/Resources/ffmpeg/ffmpeg",
      ffprobePath:
        "/Applications/Streamy.app/Contents/Resources/ffmpeg/ffprobe",
      source: "bundled",
    });
  });

  it("adds .exe on Windows", () => {
    const paths = findFfmpeg({
      ...base,
      isPackaged: true,
      platform: "win32",
      resourcesPath: "C:\\Program Files\\Streamy\\resources",
    });
    expect(paths.ffmpegPath).toBe(
      "C:\\Program Files\\Streamy\\resources\\ffmpeg\\ffmpeg.exe",
    );
    expect(paths.ffprobePath).toBe(
      "C:\\Program Files\\Streamy\\resources\\ffmpeg\\ffprobe.exe",
    );
  });

  it("uses the downloaded copies in dev", () => {
    expect(findFfmpeg(base)).toEqual({
      ffmpegPath: "/src/streamy/app/vendor/ffmpeg/darwin-arm64/ffmpeg",
      ffprobePath: "/src/streamy/app/vendor/ffmpeg/darwin-arm64/ffprobe",
      source: "vendor",
    });
  });

  it("falls back to the PATH in dev when nothing was downloaded", () => {
    expect(findFfmpeg({ ...base, exists: () => false })).toEqual({
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      source: "system",
    });
    expect(
      findFfmpeg({ ...base, platform: "win32", exists: () => false }),
    ).toMatchObject({ ffmpegPath: "ffmpeg.exe", source: "system" });
  });

  it("lets STREAMY_FFMPEG_DIR override both in dev (and the e2e tests)", () => {
    const env = { STREAMY_FFMPEG_DIR: "/opt/ffmpeg-test" };
    expect(findFfmpeg({ ...base, env })).toEqual({
      ffmpegPath: "/opt/ffmpeg-test/ffmpeg",
      ffprobePath: "/opt/ffmpeg-test/ffprobe",
      source: "env",
    });
  });

  it("ignores STREAMY_FFMPEG_DIR in the installed app", () => {
    const env = { STREAMY_FFMPEG_DIR: "/tmp/not-ffmpeg" };
    expect(findFfmpeg({ ...base, isPackaged: true, env })).toMatchObject({
      ffmpegPath: "/Applications/Streamy.app/Contents/Resources/ffmpeg/ffmpeg",
      source: "bundled",
    });
  });

  it("ignores an empty STREAMY_FFMPEG_DIR", () => {
    const env = { STREAMY_FFMPEG_DIR: " " };
    expect(findFfmpeg({ ...base, env }).source).toBe("vendor");
  });
});
