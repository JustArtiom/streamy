import { expect, test } from "./fixtures";
import { isAlive } from "./support/processes";
import { TORRENT_NAME } from "./support/media";
import { addMagnet, expectTestTorrentPage, recentList } from "./support/ui";

test("remembers a torrent across restarts, and reopens it without peers", async ({
  launch,
  seeder,
}) => {
  const first = await launch();
  await addMagnet(first.page, seeder.magnet);
  await expectTestTorrentPage(first.page);
  await first.close();

  // Nobody shares it anymore: only the library's saved metadata is left.
  await seeder.stop();

  const second = await launch();
  const recent = recentList(second.page);
  await expect(recent.getByRole("link", { name: TORRENT_NAME })).toBeVisible();
  await recent.getByRole("link", { name: TORRENT_NAME }).click();

  await expectTestTorrentPage(second.page);
  const { torrent } = await second.torrent(seeder.infoHash);
  expect(torrent?.peers).toBe(0);
});

test("recovers when the engine process dies", async ({ app, seeder }) => {
  const { page } = app;
  await addMagnet(page, seeder.magnet);
  await expectTestTorrentPage(page);
  const crashed = await app.enginePid();
  expect(crashed).not.toBeNull();

  // The banner shows from the crash until the engine is back (at least
  // the 1 s restart delay): start looking before the kill so it's not missed.
  // The visible banner, not the copy in the screen-reader live region.
  const banner = page
    .getByText("Reconnecting to the playback engine…")
    .and(page.locator(":not(.sr-only *)"));
  const bannerShown = banner.waitFor({ state: "visible" });
  process.kill(crashed ?? 0, "SIGKILL");
  await bannerShown;
  await expect(banner).toBeHidden();

  // A new engine process, and the torrent page works with it: it opened the
  // torrent again (the new engine started with none).
  expect(isAlive(crashed ?? 0)).toBe(false);
  await expect.poll(() => app.enginePid()).not.toBeNull();
  expect(await app.enginePid()).not.toBe(crashed);
  await expect
    .poll(async () => (await app.torrent(seeder.infoHash)).status)
    .toBe(200);
  await expectTestTorrentPage(page);
});
