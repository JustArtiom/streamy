import { describe, expect, it } from "vitest";
import { ffmpegEnv, ffmpegSpawnOptions } from "./run";

describe("ffmpeg's environment", () => {
  it("drops proxies (they'd get our token URLs) and FFREPORT, in any case", () => {
    const env = ffmpegEnv({
      PATH: "/usr/bin",
      http_proxy: "http://proxy:3128",
      HTTPS_PROXY: "http://proxy:3128",
      All_Proxy: "socks5://proxy",
      no_proxy: "localhost",
      NO_PROXY: "localhost",
      FFREPORT: "file=/tmp/report.log",
      LANG: "en_US.UTF-8",
    });
    expect(env).toEqual({ PATH: "/usr/bin", LANG: "en_US.UTF-8" });
  });

  it("hides the console window on Windows", () => {
    expect(ffmpegSpawnOptions().windowsHide).toBe(true);
  });
});
