import { app, type BrowserWindow, net, type WebContents } from "electron";
import { ENGINE_API_BASE, type Health } from "../shared/engine-api";
import type { EngineHost } from "./engine/host";
import type { Logger } from "./logs";

// The smoke test (PLAN §9): CI runs the packaged app with STREAMY_SMOKE=1.
// It starts as usual, but its window is never shown. It checks that the
// engine starts, that /v1/health answers through the real app:// handler
// and proxy, that ffmpeg runs, that the UI's preload loaded and that the UI
// itself rendered. Then it prints one JSON line and exits: 0 = passed,
// 1 = failed.
//
//   STREAMY_SMOKE=1 <Streamy executable> --user-data-dir=<a throwaway folder>
//
// --user-data-dir is required, so a test never touches real settings,
// videos or logs. Examples of the executable:
//   macOS   dist/mac-arm64/Streamy.app/Contents/MacOS/Streamy
//   Windows dist/win-unpacked/Streamy.exe
//   Linux   dist/linux-unpacked/streamy   (in CI: under xvfb-run)
//   dev     npx electron . (after `npm run build`)

/** The whole check must be done by then. */
export const SMOKE_TIMEOUT_MS = 90_000;
/** How long ffmpeg's version may stay unknown (the engine may still be checking). */
const FFMPEG_CHECK_MS = 30_000;
/** How long the UI may take to render once its page has loaded. */
const UI_RENDER_MS = 15_000;
const POLL_MS = 500;

export function isSmokeTest(): boolean {
  return process.env.STREAMY_SMOKE === "1";
}

/** What /v1/health said, judged. */
export type HealthCheck =
  | { status: "pass"; health: Health }
  /** ffmpeg's version isn't known yet: ask again. */
  | { status: "wait" }
  | { status: "fail"; error: string };

export function checkHealth(httpStatus: number, body: unknown): HealthCheck {
  if (httpStatus !== 200) {
    return { status: "fail", error: `/v1/health answered ${httpStatus}` };
  }
  if (!isHealth(body)) {
    return {
      status: "fail",
      error: "/v1/health answered something unexpected",
    };
  }
  if (body.ffmpeg.version !== null) return { status: "pass", health: body };
  if (body.ffmpeg.error !== null) {
    return {
      status: "fail",
      error: `ffmpeg doesn't work: ${body.ffmpeg.error}`,
    };
  }
  return { status: "wait" };
}

function isHealth(value: unknown): value is Health {
  if (typeof value !== "object" || value === null) return false;
  const { version, ffmpeg } = value as Record<string, unknown>;
  if (typeof version !== "string") return false;
  if (typeof ffmpeg !== "object" || ffmpeg === null) return false;
  const { version: ffmpegVersion, error } = ffmpeg as Record<string, unknown>;
  return (
    (typeof ffmpegVersion === "string" || ffmpegVersion === null) &&
    (typeof error === "string" || error === null)
  );
}

type Report = Record<string, unknown>;

/** Prints the result line and exits. Only ever called once. */
async function finish(
  report: Report,
  { host, log }: { host?: EngineHost; log?: Logger },
): Promise<void> {
  const passed = report.smoke === "pass";
  const line = JSON.stringify(report);
  if (passed) log?.info({ smoke: report }, "Smoke test passed");
  else log?.error({ smoke: report }, "Smoke test failed");
  // Stop the engine cleanly: no process may be left behind.
  await host?.stop();
  const exit = () => {
    app.exit(passed ? 0 : 1);
  };
  // Exit once the line is out, or soon anyway (e.g. stdout is closed).
  setTimeout(exit, 1_000);
  process.stdout.write(`${line}\n`, exit);
}

/** For when the test can't even start (e.g. no --user-data-dir). */
export function failSmokeTest(error: string): void {
  void finish({ smoke: "fail", error }, {});
}

interface SmokeOptions {
  host: EngineHost;
  window: BrowserWindow;
  log: Logger;
}

export function runSmokeTest({ host, window, log }: SmokeOptions): void {
  const started = Date.now();
  let done = false;
  const end = (report: Report) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    void finish({ ...report, ms: Date.now() - started }, { host, log });
  };

  const timeout = setTimeout(() => {
    end({ smoke: "fail", error: "Timed out", engine: host.status() });
  }, SMOKE_TIMEOUT_MS);

  // Electron would show an error dialog and wait: fail the test instead.
  process.on("uncaughtException", (error) => {
    end({ smoke: "fail", error: `Uncaught: ${error.message}` });
  });

  void (async () => {
    try {
      await host.whenRunning(SMOKE_TIMEOUT_MS);
      const uiProblem = await checkUi(window.webContents);
      const deadline = Date.now() + FFMPEG_CHECK_MS;
      for (;;) {
        const response = await net.fetch(`${ENGINE_API_BASE}/v1/health`);
        const body: unknown = await response.json().catch(() => null);
        const check = checkHealth(response.status, body);
        if (check.status === "pass") {
          end({
            smoke: uiProblem === null ? "pass" : "fail",
            ...(uiProblem !== null && { error: uiProblem }),
            status: response.status,
            version: check.health.version,
            ffmpeg: check.health.ffmpeg.version,
            encoder: check.health.encoder,
          });
          return;
        }
        if (check.status === "fail" || Date.now() > deadline) {
          end({
            smoke: "fail",
            error:
              check.status === "fail"
                ? check.error
                : "ffmpeg's version stayed unknown",
            status: response.status,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    } catch (error) {
      end({
        smoke: "fail",
        error: error instanceof Error ? error.message : String(error),
        engine: host.status(),
      });
    }
  })();
}

type UiContents = Pick<WebContents, "isLoading" | "once" | "executeJavaScript">;

interface UiCheckOptions {
  renderMs?: number;
  pollMs?: number;
}

/**
 * Waits for the UI to load, then checks that the preload gave it
 * window.streamy and that React drew something into #root (so the UI's
 * bundle loaded and ran). Returns what's wrong, or null.
 */
export async function checkUi(
  contents: UiContents,
  { renderMs = UI_RENDER_MS, pollMs = POLL_MS }: UiCheckOptions = {},
): Promise<string | null> {
  if (contents.isLoading()) {
    await new Promise<void>((resolve, reject) => {
      contents.once("did-finish-load", () => {
        resolve();
      });
      contents.once("did-fail-load", (_event, code, description) => {
        reject(new Error(`The UI didn't load: ${description} (${code})`));
      });
    });
  }
  const type: unknown = await contents.executeJavaScript(
    "typeof window.streamy",
  );
  if (type !== "object") return "The UI's preload script didn't load";

  // React renders a moment after the page has loaded.
  const deadline = Date.now() + renderMs;
  for (;;) {
    const children: unknown = await contents.executeJavaScript(
      'document.getElementById("root")?.childElementCount ?? 0',
    );
    if (typeof children === "number" && children > 0) return null;
    if (Date.now() > deadline) return "The UI didn't render (#root is empty)";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
