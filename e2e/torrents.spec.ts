import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { SAMPLE, TORRENT_NAME } from "./support/media";
import { udpSockets } from "./support/processes";
import {
  addMagnet,
  addTorrentFile,
  expectTestTorrentPage,
  recentList,
} from "./support/ui";

test("adds a magnet and lists the torrent's files, talking only to the seeder", async ({
  app,
  seeder,
}) => {
  await addMagnet(app.page, seeder.magnet);

  await expect(app.page).toHaveURL(`app://streamy/torrent/${seeder.infoHash}`);
  await expectTestTorrentPage(app.page);

  // Test mode keeps the engine to the peers it's given: DHT, UDP trackers,
  // LSD and UPnP/NAT-PMP would all show up as UDP sockets.
  const engine = await app.enginePid();
  expect(engine).not.toBeNull();
  expect(await udpSockets(engine ?? 0)).toEqual([]);
});

test("adds a .torrent file picked in Home", async ({ app, seeder }) => {
  await addTorrentFile(app.page, seeder.torrentFile);

  await expect(app.page).toHaveURL(`app://streamy/torrent/${seeder.infoHash}`);
  await expectTestTorrentPage(app.page);
});

test("removes a torrent: the video only, then completely", async ({
  app,
  seeder,
}) => {
  const { page } = app;
  const data = join(app.workspace.torrentsDir, seeder.infoHash);
  await addMagnet(page, seeder.magnet);
  await expectTestTorrentPage(page);

  // Read a little of the video, so there's downloaded data to delete.
  const { torrent } = await app.torrent(seeder.infoHash);
  const sample = torrent?.files.find((file) => file.name === SAMPLE.name);
  expect(sample).toBeDefined();
  const read = await app.api(
    `/v1/torrents/${seeder.infoHash}/files/${sample?.index}/stream`,
    { headers: { Range: "bytes=0-65535" } },
  );
  expect(read.status).toBe(206);
  await expect.poll(() => existsSync(data)).toBe(true);

  // 1. Delete the downloaded video: it stays in Recent.
  await page.getByRole("button", { name: "Remove…" }).click();
  let dialog = page.getByRole("dialog", { name: `Remove ${TORRENT_NAME}?` });
  await expect(
    dialog.getByRole("radio", { name: /Delete the downloaded video/ }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Delete video" }).click();

  await expect(page).toHaveURL("app://streamy/");
  await expect(
    recentList(page).getByRole("link", { name: TORRENT_NAME }),
  ).toBeVisible();
  await expect.poll(() => existsSync(data)).toBe(false);

  // 2. Open it again from Recent, and remove it from Streamy for good.
  await recentList(page).getByRole("link", { name: TORRENT_NAME }).click();
  await expectTestTorrentPage(page);
  await page.getByRole("button", { name: "Remove…" }).click();
  dialog = page.getByRole("dialog", { name: `Remove ${TORRENT_NAME}?` });
  await dialog.getByRole("radio", { name: /Remove it from Streamy/ }).check();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();

  await expect(page).toHaveURL("app://streamy/");
  await expect(recentList(page)).toBeHidden();
  expect((await app.library()).recent).toEqual([]);
});
