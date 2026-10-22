import { defineConfig } from "@playwright/test";

// End-to-end tests: the real app (Electron, the engine, the bundled ffmpeg)
// against a local seeder, no internet. How they work: e2e/fixtures.ts.
//
//   npm run e2e                     build, then run them all (macOS, Linux)
//   npm run e2e -- e2e/player.spec.ts -g "360p"     some of them
//
// Needs the bundled ffmpeg (`npm run ffmpeg`). Nothing shows on screen and
// nothing plays out loud (src/main/test-mode.ts). Knobs:
//   E2E_SKIP_BUILD=1    reuse the last build in .e2e/build (when only the
//                       tests changed)
//   E2E_TMP_DIR=<dir>   where the throwaway profiles go (default: the OS's)
//   E2E_NO_SANDBOX=1    Linux without user namespaces for Chromium's sandbox
//   STREAMY_FFMPEG_DIR  another ffmpeg/ffprobe folder

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  // global-setup.ts builds the app and makes the test videos.
  globalSetup: "./e2e/global-setup.ts",
  // One at a time: each test runs a whole Electron app, an engine and a
  // seeder, and some measure how fast video starts.
  workers: 1,
  fullyParallel: false,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Traces, screenshots and logs (see fixtures.ts), kept for failed tests only.
  outputDir: ".e2e/results",
  preserveOutput: "failures-only",
  reporter: ci
    ? [["list"], ["html", { outputFolder: ".e2e/report", open: "never" }]]
    : [["list"]],
});
