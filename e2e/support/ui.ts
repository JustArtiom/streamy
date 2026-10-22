import { expect, type Locator, type Page } from "@playwright/test";
import { DUB, SAMPLE, SAMPLE_SUBTITLES, TORRENT_NAME } from "./media";

// The app's screens, found the way people see them: roles, labels, text.

/** A local seeder answers within a second or two; this is generous for CI. */
export const METADATA_TIMEOUT_MS = 30_000;

/** Pastes a magnet into Home's box and presses Play. */
export async function addMagnet(page: Page, magnet: string): Promise<void> {
  await page
    .getByRole("textbox", { name: "Magnet link or info hash" })
    .fill(magnet);
  await page.getByRole("button", { name: "Play", exact: true }).click();
}

/** Picks a .torrent with Home's "Open a .torrent file" (no OS dialog). */
export async function addTorrentFile(
  page: Page,
  torrentFile: Buffer,
): Promise<void> {
  await page.getByLabel("Choose a .torrent file").setInputFiles({
    name: `${TORRENT_NAME}.torrent`,
    mimeType: "application/x-bittorrent",
    buffer: torrentFile,
  });
}

/** "Videos 2", "Subtitles 1": a group of the torrent page's file list. */
export function fileGroup(page: Page, title: "Videos" | "Subtitles"): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name: new RegExp(`^${title}`) }),
  });
}

/** The torrent page of the test torrent, with all its files listed. */
export async function expectTestTorrentPage(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { level: 1, name: TORRENT_NAME }),
  ).toBeVisible({ timeout: METADATA_TIMEOUT_MS });

  const videos = fileGroup(page, "Videos");
  await expect(videos.getByRole("heading")).toHaveText(/^Videos\s*2$/, {
    timeout: METADATA_TIMEOUT_MS,
  });
  await expect(videos.getByText(DUB.name, { exact: true })).toBeVisible();
  await expect(videos.getByText(SAMPLE.name, { exact: true })).toBeVisible();
  await expect(
    videos.getByRole("link", { name: `Play ${SAMPLE.name}` }),
  ).toBeVisible();

  const subtitles = fileGroup(page, "Subtitles");
  await expect(subtitles.getByRole("heading")).toHaveText(/^Subtitles\s*1$/);
  await expect(
    subtitles.getByText(SAMPLE_SUBTITLES.name, { exact: true }),
  ).toBeVisible();
}

/** Home's Recent list. */
export function recentList(page: Page): Locator {
  return page.getByRole("region", { name: "Recent" });
}

/**
 * Opens Settings (the title bar's gear) unless it's open already, on one of
 * its sections. Returns the dialog.
 */
export async function openSettings(
  page: Page,
  section: "General" | "Storage" | "Network" | "Advanced",
): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: "Settings" });
  if (!(await dialog.isVisible())) {
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
  }
  await dialog
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: section, exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: section, exact: true }),
  ).toBeVisible();
  return dialog;
}
