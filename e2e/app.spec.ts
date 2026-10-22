import { expect, test } from "./fixtures";
import { pinnedFfmpegVersion } from "./support/paths";
import { openSettings } from "./support/ui";

test("starts hidden and muted, with the engine and the bundled ffmpeg", async ({
  app,
}) => {
  const { page } = app;

  // Test mode: the window exists but is never shown, and makes no sound.
  expect(await app.windows()).toEqual([{ visible: false, muted: true }]);
  await expect(
    page.getByRole("heading", { name: "What do you want to watch?" }),
  ).toBeVisible();

  // The engine runs in its own process, and got STREAMY_TEST_MODE from
  // main's environment (it logs that it stays offline).
  expect(await app.enginePid()).toEqual(expect.any(Number));
  await expect
    .poll(() =>
      app
        .logLines("engine.log")
        .some((line) => line.msg === "Test mode: local peers only"),
    )
    .toBe(true);

  const settings = await openSettings(page, "Advanced");
  const version = pinnedFfmpegVersion().replaceAll(".", "\\.");
  // "Running · ffmpeg 8.1.3 · VideoToolbox": the encoder shows once the
  // engine has tried them (a few seconds after it starts).
  await expect(
    settings.getByText(new RegExp(`^Running · ffmpeg ${version} · \\S`)),
  ).toBeVisible();
});
