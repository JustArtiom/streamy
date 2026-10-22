import type { Health, MediaInfo } from "../src/shared/engine-api";
import { encoderLabel } from "../src/renderer/src/lib/encoders";
import { expect, test } from "./fixtures";
import type { StreamyApp } from "./support/app";
import { DUB, SAMPLE } from "./support/media";
import {
  choose,
  clickControl,
  expectPlaysFrom,
  expectSubtitleInSync,
  menuValue,
  movieTime,
  player,
  showStats,
  statsValue,
  subtitleLine,
} from "./support/player";
import { isAlive } from "./support/processes";
import type { Seeder } from "./support/seeder";
import { addMagnet, expectTestTorrentPage } from "./support/ui";

/**
 * Adds the test torrent, presses Play on one of its videos, and waits until
 * it plays (from the start). Returns how long that took.
 */
async function play(
  app: StreamyApp,
  seeder: Seeder,
  file: string,
): Promise<number> {
  await addMagnet(app.page, seeder.magnet);
  await expectTestTorrentPage(app.page);
  const pressed = Date.now();
  await app.page.getByRole("link", { name: `Play ${file}` }).click();
  await expect(app.page).toHaveURL(
    new RegExp(`/watch/${seeder.infoHash}/\\d+$`),
  );
  await expectPlaysFrom(app.page, 0);
  return Date.now() - pressed;
}

/**
 * ffmpeg processes of playback sessions: the ones writing HLS. (They run in
 * their session's folder with relative output names, so the folder itself
 * isn't on the command line.)
 */
async function sessionFfmpeg(app: StreamyApp) {
  return (await app.mediaProcesses()).filter(({ args }) =>
    args.includes("-hls_segment_filename"),
  );
}

test("plays an MP4 directly, seeks far, and shows its external subtitles", async ({
  app,
  seeder,
}, testInfo) => {
  const { page } = app;
  const started = await play(app, seeder, SAMPLE.name);

  await showStats(page);
  await expect(statsValue(page, "Mode")).toHaveText(/^direct — /);
  await expect(statsValue(page, "Encoder")).toHaveText(encoderLabel(null));

  // 6 = 60 % into the movie.
  const target = Math.round(SAMPLE.seconds * 0.6);
  await page.keyboard.press("6");
  const seeked = await expectPlaysFrom(page, target);
  testInfo.annotations.push({
    type: "timings",
    description: `Play → 2 s played: ${started} ms. Seek to 60 % → 2 s played: ${seeked} ms`,
  });

  await clickControl(page, "Turn subtitles on");
  await expectSubtitleInSync(page, "External cue");
  await clickControl(page, "Turn subtitles off");
  await expect(subtitleLine(page)).toBeHidden();
});

test.describe("from a slow seeder", () => {
  // Like a real torrent, the video arrives while it plays (Dub.mkv takes
  // ~40 s at this rate, for 2 min of movie): the session's ffmpeg is still
  // at work, waiting for pieces, when the viewer leaves.
  test.use({ seederUploadLimit: 64 * 1024 });

  test("remuxes an MKV: dub switch, embedded subtitles, ffmpeg stops on leaving", async ({
    app,
    seeder,
  }) => {
    const { page } = app;
    await play(app, seeder, DUB.name);

    await showStats(page);
    await expect(statsValue(page, "Mode")).toHaveText(/^remux — /);

    // Switching the audio starts a new session where the video is.
    const switchedAt = await movieTime(page);
    await choose(page, "Audio", /^German/);
    await expectPlaysFrom(page, switchedAt);
    expect(await menuValue(page, "Audio")).toMatch(/^German/);

    // The engine's session plays the German track: its heartbeats save it.
    const fileIndex = await app.fileIndex(seeder.infoHash, DUB.name);
    const { body } = await app.api<{ media: MediaInfo }>(
      `/v1/torrents/${seeder.infoHash}/files/${fileIndex}/media`,
    );
    const german = body.media.audioTracks.find(
      (track) => track.language === "de",
    );
    expect(german).toBeDefined();
    await expect
      .poll(
        async () =>
          (await app.savedProgress(seeder.infoHash, fileIndex))?.audioTrack,
      )
      .toBe(german?.index);

    // C turns on the embedded English subtitles, in step with the picture.
    await page.keyboard.press("c");
    await expectSubtitleInSync(page, "Embedded cue");
    await expectPlaysFrom(page, await movieTime(page));
    await expectSubtitleInSync(page, "Embedded cue");

    // Leaving the player ends its session: its ffmpeg (still waiting for
    // the rest of the video) stops.
    expect(await sessionFfmpeg(app)).not.toEqual([]);
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Back" })
      .click();
    await expectTestTorrentPage(page);
    await expect.poll(() => sessionFfmpeg(app)).toEqual([]);
    await expect.poll(() => app.mediaProcesses()).toEqual([]);
  });

  test("the engine dies mid-movie: its ffmpeg goes too, and the video carries on", async ({
    app,
    seeder,
  }) => {
    const { page } = app;
    await play(app, seeder, DUB.name);
    const orphans = await sessionFfmpeg(app);
    expect(orphans).not.toEqual([]);
    const engine = await app.enginePid();
    const diedAt = await movieTime(page);

    // Shown from the crash until the engine is back (at least the 1 s
    // restart delay): start looking before the kill so it's not missed.
    const overlay = player(page).getByText("Reconnecting…", { exact: true });
    const overlayShown = overlay.waitFor({ state: "visible" });
    process.kill(engine ?? 0, "SIGKILL");
    await overlayShown;

    // On macOS and Linux ffmpeg would outlive the engine: main kills it.
    for (const { pid } of orphans) {
      await expect.poll(() => isAlive(pid)).toBe(false);
    }
    await expect(overlay).toBeHidden();
    await expectPlaysFrom(page, diedAt);
  });
});

test("switches to 360p: converted with the engine's encoder, at the same spot", async ({
  app,
  seeder,
}) => {
  const { page } = app;
  await play(app, seeder, SAMPLE.name);
  await page.keyboard.press("3"); // 30 %: somewhere in the middle.
  await expectPlaysFrom(page, Math.round(SAMPLE.seconds * 0.3));
  await showStats(page);
  await expect(statsValue(page, "Mode")).toHaveText(/^direct — /);

  const switchedAt = await movieTime(page);
  await choose(page, "Quality", "360p");
  await expect(statsValue(page, "Mode")).toHaveText(/^transcode — /);
  await expectPlaysFrom(page, switchedAt);

  const { body: health } = await app.api<Health>("/v1/health");
  await expect(statsValue(page, "Encoder")).toHaveText(
    encoderLabel(health.encoder),
  );
  await expect(statsValue(page, "Output")).toContainText("×360");
});

test("quit mid-movie, relaunch: Continue watching resumes it", async ({
  launch,
  seeder,
}) => {
  const first = await launch();
  await play(first, seeder, SAMPLE.name);
  // 5 = 50 %: well past the 30 s Continue watching needs.
  const target = Math.round(SAMPLE.seconds * 0.5);
  await first.page.keyboard.press("5");
  await expectPlaysFrom(first.page, target);

  // The heartbeat (every 5 s) saves the position, then a thumbnail is made.
  await expect
    .poll(
      async () => {
        const [item] = (await first.library()).continueWatching;
        return {
          saved: (item?.position ?? 0) >= target,
          thumbnail: item?.thumbnailUrl ?? null,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ saved: true, thumbnail: expect.any(String) });
  await first.close(); // While it plays.

  const second = await launch();
  const { page } = second;
  const [saved] = (await second.library()).continueWatching;
  if (!saved) throw new Error("Nothing in Continue watching");

  const card = page
    .getByRole("region", { name: "Continue watching" })
    .getByRole("listitem")
    .filter({ hasText: "Sample" });
  await expect(card).toBeVisible();
  // Its thumbnail has loaded.
  await expect
    .poll(() =>
      card
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
    )
    .toBeGreaterThan(0);

  // The card resumes straight away (choosing it is the answer).
  await card.getByRole("link", { name: "Sample" }).click();
  await expectPlaysFrom(page, Math.floor(saved.position));

  // Opened without that choice (here: the window loads the player's
  // address from Home), the player asks first. "Resume" has the focus:
  // Enter resumes.
  await page.getByRole("banner").getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL("app://streamy/");
  await page.evaluate((path) => {
    window.location.assign(path);
  }, `/watch/${saved.infoHash}/${saved.fileIndex}`);
  const resume = page.getByRole("button", { name: /^Resume at \d+:\d\d$/ });
  await expect(resume).toBeFocused();
  const [minutes = 0, seconds = 0] = ((await resume.textContent()) ?? "")
    .replace("Resume at", "")
    .split(":")
    .map(Number);
  await page.keyboard.press("Enter");
  await expectPlaysFrom(page, minutes * 60 + seconds);
});
